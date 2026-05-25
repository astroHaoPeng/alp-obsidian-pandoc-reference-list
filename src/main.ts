import {
  Events,
  MarkdownView,
  Menu,
  Plugin,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  debounce,
  normalizePath,
  setIcon,
} from 'obsidian';
import which from 'which';

import {
  citeKeyCacheField,
  citeKeyPlugin,
  bibManagerField,
  editorTooltipHandler,
} from './editorExtension';
import { t } from './lang/helpers';
import { processCiteKeys } from './markdownPostprocessor';
import {
  DEFAULT_SETTINGS,
  ReferenceListSettings,
  ReferenceListSettingsTab,
} from './settings';
import { TooltipManager } from './tooltip';
import { ReferenceListView, viewType } from './view';
import { PromiseCapability, fixPath, getVaultRoot } from './helpers';
import path from 'path';
import { BibManager, getScopedSettings } from './bib/bibManager';
import { CiteSuggest } from './citeSuggest/citeSuggest';
import { isZoteroRunning } from './bib/helpers';

const bibliographyExtensions = new Set(['bib', 'json', 'yaml', 'yml']);

function isBibliographyFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile && bibliographyExtensions.has(file.extension);
}

function getFileRelativePath(sourceFile: TFile, targetPath: string) {
  const sourceDir = path.posix.dirname(sourceFile.path);
  const relativePath = path.posix.relative(sourceDir, targetPath);

  return relativePath || path.posix.basename(targetPath);
}

function bibliographyMatchesPath(
  sourceFile: TFile,
  bibliography: string,
  targetPath: string
) {
  const sourceDir = path.posix.dirname(sourceFile.path);
  const normalizedBibliography = normalizePath(bibliography);
  const noteRelativePath = normalizePath(
    path.posix.join(sourceDir, normalizedBibliography)
  );
  const vaultRelativePath = normalizePath(normalizedBibliography);

  if (noteRelativePath === targetPath || vaultRelativePath === targetPath) {
    return true;
  }

  if (path.isAbsolute(bibliography)) {
    const targetFilePath = path.join(getVaultRoot(), targetPath);
    return path.normalize(bibliography) === path.normalize(targetFilePath);
  }

  return false;
}

function updateBibliographyPath(
  sourceFile: TFile,
  bibliography: unknown,
  oldPath: string,
  newPath: string
) {
  const getUpdatedPath = (value: unknown) => {
    if (
      typeof value === 'string' &&
      bibliographyMatchesPath(sourceFile, value, oldPath)
    ) {
      return getFileRelativePath(sourceFile, newPath);
    }

    return value;
  };

  if (Array.isArray(bibliography)) {
    let changed = false;
    const updated = bibliography.map((value) => {
      const next = getUpdatedPath(value);
      changed ||= next !== value;
      return next;
    });

    return changed ? updated : bibliography;
  }

  return getUpdatedPath(bibliography);
}

export default class ReferenceList extends Plugin {
  settings: ReferenceListSettings;
  emitter: Events;
  tooltipManager: TooltipManager;
  cacheDir: string;
  bibManager: BibManager;
  _initPromise: PromiseCapability<void>;

  get initPromise() {
    if (!this._initPromise) {
      return (this._initPromise = new PromiseCapability());
    }
    return this._initPromise;
  }

  async onload() {
    const { app } = this;

    await this.loadSettings();

    this.registerView(
      viewType,
      (leaf: WorkspaceLeaf) => new ReferenceListView(leaf, this)
    );

    this.cacheDir = path.join(getVaultRoot(), '.pandoc');
    this.emitter = new Events();
    this.bibManager = new BibManager(this);
    this.initPromise.promise
      .then(() => {
        if (this.settings.pullFromZotero) {
          return this.bibManager.loadAndRefreshGlobalZBib();
        } else {
          return this.bibManager.loadGlobalBibFile();
        }
      })
      .finally(() => this.bibManager.initPromise.resolve());

    this.addSettingTab(new ReferenceListSettingsTab(this));
    this.registerEditorSuggest(new CiteSuggest(app, this));
    this.tooltipManager = new TooltipManager(this);
    this.registerMarkdownPostProcessor(processCiteKeys(this));
    this.registerEditorExtension([
      bibManagerField.init(() => this.bibManager),
      citeKeyCacheField,
      citeKeyPlugin,
      editorTooltipHandler(this.tooltipManager),
    ]);

    // No need to block execution
    fixPath().then(async () => {
      if (!this.settings.pathToPandoc) {
        try {
          // Attempt to find if/where pandoc is located on the user's machine
          const pathToPandoc = await which('pandoc');
          this.settings.pathToPandoc = pathToPandoc;
          this.saveSettings();
        } catch {
          // We can ignore any errors here
        }
      }

      this.initPromise.resolve();
      this.app.workspace.trigger('parse-style-settings');
    });

    this.addCommand({
      id: 'focus-reference-list-view',
      name: t('Show reference list'),
      callback: async () => {
        this.initLeaf();
      },
    });

    document.body.toggleClass(
      'pwc-tooltips',
      !!this.settings.showCitekeyTooltips
    );

    this.registerEvent(
      app.metadataCache.on(
        'changed',
        debounce(
          async (file) => {
            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;

            const activeView = app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView && file === activeView.file) {
              this.processReferences();
            }
          },
          100,
          true
        )
      )
    );

    this.registerEvent(
      app.workspace.on(
        'active-leaf-change',
        debounce(
          async (leaf) => {
            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;

            app.workspace.iterateRootLeaves((rootLeaf) => {
              if (rootLeaf === leaf) {
                if (leaf.view instanceof MarkdownView) {
                  this.processReferences();
                } else {
                  this.view?.setNoContentMessage();
                }
              }
            });
          },
          100,
          true
        )
      )
    );

    this.registerEvent(
      app.vault.on(
        'rename',
        debounce(
          async (file, oldPath) => {
            await this.initPromise.promise;
            await this.bibManager.initPromise.promise;

            if (isBibliographyFile(file)) {
              await this.updateBibliographyFrontmatter(oldPath, file.path);
            }

            const activeView = app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView?.file instanceof TFile) {
              this.bibManager.fileCache.delete(activeView.file);
              this.processReferences();
            }
          },
          100,
          true
        )
      )
    );

    (async () => {
      this.initStatusBar();
      this.setStatusBarLoading();

      await this.initPromise.promise;
      await this.bibManager.initPromise.promise;

      this.setStatusBarIdle();
      this.processReferences();
    })();
  }

  onunload() {
    document.body.removeClass('pwc-tooltips');
    this.app.workspace
      .getLeavesOfType(viewType)
      .forEach((leaf) => leaf.detach());
    this.bibManager.destroy();
  }

  async updateBibliographyFrontmatter(oldPath: string, newPath: string) {
    oldPath = normalizePath(oldPath);
    newPath = normalizePath(newPath);

    for (const file of this.app.vault.getMarkdownFiles()) {
      const metadata = this.app.metadataCache.getFileCache(file);
      if (!metadata?.frontmatter?.bibliography) continue;

      let changed = false;
      try {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          const nextBibliography = updateBibliographyPath(
            file,
            frontmatter.bibliography,
            oldPath,
            newPath
          );

          if (nextBibliography !== frontmatter.bibliography) {
            frontmatter.bibliography = nextBibliography;
            changed = true;
          }
        });

        if (changed) {
          this.bibManager.fileCache.delete(file);
        }
      } catch (e) {
        console.error(e);
      }
    }
  }

  statusBarIcon: HTMLElement;
  initStatusBar() {
    const ico = (this.statusBarIcon = this.addStatusBarItem());
    ico.addClass('pwc-status-icon', 'clickable-icon');
    ico.setAttr('aria-label', t('Pandoc reference list settings'));
    ico.setAttr('data-tooltip-position', 'top');
    this.setStatusBarIdle();
    let isOpen = false;
    ico.addEventListener('click', () => {
      if (isOpen) return;
      const { settings } = this;
      const menu = (new Menu() as any)
        .addSections(['settings', 'actions'])
        .addItem((item: any) =>
          item
            .setSection('settings')
            .setIcon('lucide-message-square')
            .setTitle(t('Show citekey tooltips'))
            .setChecked(!!settings.showCitekeyTooltips)
            .onClick(() => {
              this.settings.showCitekeyTooltips = !settings.showCitekeyTooltips;
              this.saveSettings();
            })
        )
        .addItem((item: any) =>
          item
            .setSection('settings')
            .setIcon('lucide-at-sign')
            .setTitle(t('Show citekey suggestions'))
            .setChecked(!!settings.enableCiteKeyCompletion)
            .onClick(() => {
              this.settings.enableCiteKeyCompletion =
                !settings.enableCiteKeyCompletion;
              this.saveSettings();
            })
        )
        .addItem((item: any) =>
          item
            .setSection('actions')
            .setIcon('lucide-rotate-cw')
            .setTitle(t('Refresh bibliography'))
            .onClick(async () => {
              const activeView =
                this.app.workspace.getActiveViewOfType(MarkdownView);
              if (activeView) {
                const file = activeView.file;

                if (this.bibManager.fileCache.has(file)) {
                  const cache = this.bibManager.fileCache.get(file);
                  if (cache.source !== this.bibManager) {
                    this.bibManager.fileCache.delete(file);
                    this.processReferences();
                    return;
                  }
                }
              }

              this.bibManager.reinit(true);
              await this.bibManager.initPromise.promise;
              this.processReferences();
            })
        );

      const rect = ico.getBoundingClientRect();
      menu.onHide(() => {
        isOpen = false;
      });
      menu.setParentElement(ico).showAtPosition({
        x: rect.x,
        y: rect.top - 5,
        width: rect.width,
        overlap: true,
        left: false,
      });
      isOpen = true;
    });
  }

  setStatusBarLoading() {
    this.statusBarIcon.addClass('is-loading');
    setIcon(this.statusBarIcon, 'lucide-loader');
  }

  setStatusBarIdle() {
    this.statusBarIcon.removeClass('is-loading');
    setIcon(this.statusBarIcon, 'lucide-at-sign');
  }

  get view() {
    const leaves = this.app.workspace.getLeavesOfType(viewType);
    if (!leaves?.length) return null;
    return leaves[0].view as ReferenceListView;
  }

  async initLeaf() {
    if (this.view) return this.revealLeaf();

    await this.app.workspace.getRightLeaf(false).setViewState({
      type: viewType,
    });

    this.revealLeaf();

    await this.initPromise.promise;
    await this.bibManager.initPromise.promise;

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      this.processReferences();
    }
  }

  revealLeaf() {
    const leaves = this.app.workspace.getLeavesOfType(viewType);
    if (!leaves?.length) return;
    this.app.workspace.revealLeaf(leaves[0]);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(cb?: () => void) {
    document.body.toggleClass(
      'pwc-tooltips',
      !!this.settings.showCitekeyTooltips
    );

    // Refresh the reference list when settings change
    this.emitSettingsUpdate(cb);
    await this.saveData(this.settings);
  }

  emitSettingsUpdate = debounce(
    (cb?: () => void) => {
      if (this.initPromise.settled) {
        this.view?.contentEl.toggleClass(
          'collapsed-links',
          !!this.settings.hideLinks
        );

        cb && cb();

        this.processReferences();
      }
    },
    5000,
    true
  );

  processReferences = async () => {
    const { settings, view } = this;
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const scopedSettings = activeView
      ? getScopedSettings(activeView.file)
      : null;

    if (
      !settings.pathToBibliography &&
      !settings.pullFromZotero &&
      !scopedSettings?.bibliography?.length
    ) {
      return view?.setMessage(
        t(
          'Please provide the path to your pandoc compatible bibliography file in the Pandoc Reference List plugin settings.'
        )
      );
    }

    if (activeView) {
      try {
        const fileContent = await this.app.vault.cachedRead(activeView.file);
        const bib = await this.bibManager.getReferenceList(
          activeView.file,
          fileContent
        );
        const cache = this.bibManager.fileCache.get(activeView.file);

        if (
          !bib &&
          cache?.source === this.bibManager &&
          settings.pullFromZotero &&
          !(await isZoteroRunning(settings.zoteroPort)) &&
          this.bibManager.fileCache.get(activeView.file)?.keys.size
        ) {
          view?.setMessage(t('Cannot connect to Zotero'));
        } else {
          view?.setViewContent(bib);
        }
      } catch (e) {
        console.error(e);
        view?.setMessage((e as Error).message);
      }
    } else {
      view?.setNoContentMessage();
    }
  };
}
