import { Plugin, TFile, WorkspaceLeaf, Notice, PluginSettingTab, App, Setting } from "obsidian";
import { EpubView, EPUB_VIEW_TYPE } from "./epub-view";

interface ThoriumReaderSettings {
  fontSize: number;
  fontFamily: string;
  theme: string;
  thoriumServerUrl: string;
  useThoriumServer: boolean;
}

const DEFAULT_SETTINGS: ThoriumReaderSettings = {
  fontSize: 18,
  fontFamily: "Georgia",
  theme: "light",
  thoriumServerUrl: "",
  useThoriumServer: false,
};

export default class ThoriumReaderPlugin extends Plugin {
  settings: ThoriumReaderSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register the EPUB view
    this.registerView(EPUB_VIEW_TYPE, (leaf) => new EpubView(leaf, this));

    // Register .epub extension
    this.registerExtensions(["epub"], EPUB_VIEW_TYPE);

    // Command: Open EPUB file picker
    this.addCommand({
      id: "open-epub",
      name: "Open an EPUB file from vault",
      callback: () => this.openEpubFilePicker(),
    });

    // Ribbon icon
    this.addRibbonIcon("book-open", "Open EPUB", () => this.openEpubFilePicker());

    // Settings tab
    this.addSettingTab(new ThoriumSettingTab(this.app, this));
  }

  async openEpubFilePicker(): Promise<void> {
    const epubFiles = this.app.vault
      .getFiles()
      .filter((f) => f.extension === "epub");

    if (epubFiles.length === 0) {
      new Notice("No EPUB files found in your vault.");
      return;
    }

    // Use Obsidian's fuzzy suggest modal
    const { FuzzySuggestModal } = await import("obsidian");

    class EpubPickerModal extends FuzzySuggestModal<TFile> {
      plugin: ThoriumReaderPlugin;

      constructor(app: App, plugin: ThoriumReaderPlugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder("Choose an EPUB to read…");
      }

      getItems(): TFile[] {
        return epubFiles;
      }

      getItemText(item: TFile): string {
        return item.path;
      }

      onChooseItem(item: TFile): void {
        this.plugin.openEpubInView(item.path);
      }
    }

    new EpubPickerModal(this.app, this).open();
  }

  async openEpubInView(filePath: string): Promise<void> {
    // Check if already open
    const existing = this.app.workspace.getLeavesOfType(EPUB_VIEW_TYPE);
    for (const leaf of existing) {
      const view = leaf.view as EpubView;
      if (view.filePath === filePath) {
        this.app.workspace.setActiveLeaf(leaf);
        return;
      }
    }

    // Open in a new leaf
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: EPUB_VIEW_TYPE,
      state: { file: filePath },
    });
    this.app.workspace.setActiveLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    // Views are automatically cleaned up
  }
}

class ThoriumSettingTab extends PluginSettingTab {
  plugin: ThoriumReaderPlugin;

  constructor(app: App, plugin: ThoriumReaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Thorium EPUB Reader" });

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Default font size in pixels for the reader")
      .addSlider((slider) =>
        slider
          .setLimits(12, 32, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Font family")
      .setDesc("Default font for reading")
      .addDropdown((dd) =>
        dd
          .addOptions({
            Georgia: "Georgia (Serif)",
            "Palatino Linotype": "Palatino (Serif)",
            "Times New Roman": "Times (Serif)",
            Arial: "Arial (Sans)",
            Verdana: "Verdana (Sans)",
            "Segoe UI": "Segoe UI (Sans)",
            "monospace": "Monospace",
          })
          .setValue(this.plugin.settings.fontFamily)
          .onChange(async (value) => {
            this.plugin.settings.fontFamily = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default theme")
      .setDesc("Reading theme for the EPUB viewer")
      .addDropdown((dd) =>
        dd
          .addOptions({ light: "Light", sepia: "Sepia", dark: "Dark" })
          .setValue(this.plugin.settings.theme)
          .onChange(async (value) => {
            this.plugin.settings.theme = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Thorium Web Server (Advanced)" });

    containerEl.createEl("p", {
      text:
        "If you have a self-hosted Thorium Web instance with the Go Toolkit " +
        "serving your EPUBs as Web Publication Manifests, you can connect to it here. " +
        "This enables the full Thorium Web reading experience with advanced features.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Use Thorium Web server")
      .setDesc("Connect to an external Thorium Web instance instead of the built-in reader")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useThoriumServer)
          .onChange(async (value) => {
            this.plugin.settings.useThoriumServer = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Thorium Web server URL")
      .setDesc("URL of your Thorium Web instance (e.g. https://reader.example.com)")
      .addText((text) =>
        text
          .setPlaceholder("https://reader.example.com")
          .setValue(this.plugin.settings.thoriumServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.thoriumServerUrl = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
