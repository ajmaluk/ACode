/**
 * Native menu bar setup for macOS.
 *
 * On macOS, the system menu bar shows the app name and menus.
 * We populate it with proper menu items so users don't need
 * a redundant in-app menu bar.
 *
 * On Windows/Linux, we don't set up native menus since the
 * in-app menu bar in TitleBar handles everything.
 */
import { platform } from "./platform";

let menuInitialized = false;

export async function setupNativeMenus(): Promise<void> {
  if (menuInitialized) return;
  if (platform() !== "mac") return;

  try {
    const { Menu, Submenu, MenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");

    // App menu (macOS standard — includes Quit)
    const appMenu = await Submenu.new({
      text: "Dalam",
      items: [
        await MenuItem.new({
          id: "app.about",
          text: "About Dalam",
          action: () => {},
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await PredefinedMenuItem.new({ item: "Hide" }),
        await PredefinedMenuItem.new({ item: "HideOthers" }),
        await PredefinedMenuItem.new({ item: "ShowAll" }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await PredefinedMenuItem.new({ item: "Quit" }),
      ],
    });

    // File menu
    const fileMenu = await Submenu.new({
      text: "File",
      items: [
        await MenuItem.new({
          id: "file.new-file",
          text: "New File",
          accelerator: "CmdOrCtrl+N",
          action: () => emitMenuAction("file.new-file"),
        }),
        await MenuItem.new({
          id: "file.open-file",
          text: "Open File…",
          accelerator: "CmdOrCtrl+O",
          action: () => emitMenuAction("file.open-file"),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "file.save",
          text: "Save",
          accelerator: "CmdOrCtrl+S",
          action: () => emitMenuAction("file.save"),
        }),
        await MenuItem.new({
          id: "file.save-all",
          text: "Save All",
          accelerator: "CmdOrCtrl+Shift+S",
          action: () => emitMenuAction("file.save-all"),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "file.close-tab",
          text: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          action: () => emitMenuAction("file.close-tab"),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "file.preferences",
          text: "Preferences…",
          accelerator: "CmdOrCtrl+,",
          action: () => emitMenuAction("file.preferences"),
        }),
      ],
    });

    // Edit menu
    const editMenu = await Submenu.new({
      text: "Edit",
      items: [
        await PredefinedMenuItem.new({ item: "Undo" }),
        await PredefinedMenuItem.new({ item: "Redo" }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await PredefinedMenuItem.new({ item: "Cut" }),
        await PredefinedMenuItem.new({ item: "Copy" }),
        await PredefinedMenuItem.new({ item: "Paste" }),
        await PredefinedMenuItem.new({ item: "SelectAll" }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "edit.find",
          text: "Find",
          accelerator: "CmdOrCtrl+F",
          action: () => emitMenuAction("edit.find"),
        }),
        await MenuItem.new({
          id: "edit.find-replace",
          text: "Find and Replace",
          accelerator: "CmdOrCtrl+Alt+F",
          action: () => emitMenuAction("edit.find-replace"),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "edit.toggle-comment",
          text: "Toggle Comment",
          accelerator: "CmdOrCtrl+/",
          action: () => emitMenuAction("edit.toggle-comment"),
        }),
      ],
    });

    // View menu
    const viewMenu = await Submenu.new({
      text: "View",
      items: [
        await MenuItem.new({
          id: "view.toggle-sidebar",
          text: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          action: () => emitMenuAction("view.toggle-sidebar"),
        }),
        await MenuItem.new({
          id: "view.toggle-right-panel",
          text: "Toggle Right Panel",
          accelerator: "CmdOrCtrl+\\",
          action: () => emitMenuAction("view.toggle-right-panel"),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "view.toggle-word-wrap",
          text: "Toggle Word Wrap",
          accelerator: "Alt+Z",
          action: () => emitMenuAction("view.toggle-word-wrap"),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "view.zoom-in",
          text: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          action: () => emitMenuAction("view.zoom-in"),
        }),
        await MenuItem.new({
          id: "view.zoom-out",
          text: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          action: () => emitMenuAction("view.zoom-out"),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "view.agent-mode",
          text: "Agent Mode",
          accelerator: "CmdOrCtrl+E",
          action: () => emitMenuAction("view.agent-mode"),
        }),
        await MenuItem.new({
          id: "view.editor-mode",
          text: "Editor Mode",
          accelerator: "CmdOrCtrl+Shift+E",
          action: () => emitMenuAction("view.editor-mode"),
        }),
      ],
    });

    // Go menu
    const goMenu = await Submenu.new({
      text: "Go",
      items: [
        await MenuItem.new({
          id: "go.quick-open",
          text: "Quick Open",
          accelerator: "CmdOrCtrl+P",
          action: () => emitMenuAction("go.quick-open"),
        }),
        await MenuItem.new({
          id: "go.go-to-line",
          text: "Go to Line…",
          accelerator: "CmdOrCtrl+G",
          action: () => emitMenuAction("go.go-to-line"),
        }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await MenuItem.new({
          id: "go.back",
          text: "Back",
          accelerator: "CmdOrCtrl+[",
          action: () => emitMenuAction("go.back"),
        }),
        await MenuItem.new({
          id: "go.forward",
          text: "Forward",
          accelerator: "CmdOrCtrl+]",
          action: () => emitMenuAction("go.forward"),
        }),
      ],
    });

    // Terminal menu
    const terminalMenu = await Submenu.new({
      text: "Terminal",
      items: [
        await MenuItem.new({
          id: "terminal.new",
          text: "New Terminal",
          accelerator: "CmdOrCtrl+Shift+`",
          action: () => emitMenuAction("terminal.new"),
        }),
        await MenuItem.new({
          id: "terminal.toggle",
          text: "Toggle Terminal",
          accelerator: "CmdOrCtrl+J",
          action: () => emitMenuAction("terminal.toggle"),
        }),
      ],
    });

    // Window menu
    const windowMenu = await Submenu.new({
      text: "Window",
      items: [
        await PredefinedMenuItem.new({ item: "Minimize" }),
        await PredefinedMenuItem.new({ item: "Maximize" }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await PredefinedMenuItem.new({ item: "Fullscreen" }),
      ],
    });

    // Help menu
    const helpMenu = await Submenu.new({
      text: "Help",
      items: [
        await MenuItem.new({
          id: "help.shortcuts",
          text: "Keyboard Shortcuts",
          action: () => emitMenuAction("help.shortcuts"),
        }),
        await MenuItem.new({
          id: "help.command-palette",
          text: "Command Palette",
          accelerator: "CmdOrCtrl+Shift+P",
          action: () => emitMenuAction("help.command-palette"),
        }),
      ],
    });

    // Build the full menu (on macOS, Menu can only contain Submenus)
    const menu = await Menu.new({
      items: [appMenu, fileMenu, editMenu, viewMenu, goMenu, terminalMenu, windowMenu, helpMenu],
    });

    await menu.setAsAppMenu();
    menuInitialized = true;
  } catch (err) {
    console.error("[NativeMenu] Failed to set up native menus:", err);
  }
}

/**
 * Emit a custom event that the frontend can listen to.
 * This bridges native menu clicks to the React app.
 */
function emitMenuAction(actionId: string): void {
  window.dispatchEvent(new CustomEvent("native-menu-action", { detail: { actionId } }));
}
