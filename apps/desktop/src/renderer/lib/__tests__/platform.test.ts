import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { modKey, isWindows, isMac, isLinux, defaultShell, wrapCommandForPlatform, shortcut, resetPlatformCache } from "../platform";

// Mock navigator
function setPlatform(mockPlatform: string, mockUa?: string) {
  Object.defineProperty(navigator, "platform", {
    value: mockPlatform,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, "userAgent", {
    value: mockUa || "",
    configurable: true,
    writable: true,
  });
}

describe("platform detection", () => {
  beforeEach(() => {
    // Reset cache by clearing it (we'll rely on fresh tests)
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isMac", () => {
    beforeEach(() => resetPlatformCache());

    it("returns true on macOS", () => {
      setPlatform("MacIntel");
      expect(isMac()).toBe(true);
    });

    it("returns true for MacPPC", () => {
      setPlatform("MacPPC");
      expect(isMac()).toBe(true);
    });

    it("returns true from user-agent", () => {
      setPlatform("Win32", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
      expect(isMac()).toBe(true);
    });

    it("returns false on Windows", () => {
      setPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
      expect(isMac()).toBe(false);
    });
  });

  describe("isWindows", () => {
    beforeEach(() => resetPlatformCache());

    it("returns true on Windows", () => {
      setPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
      expect(isWindows()).toBe(true);
    });

    it("returns true for Win64", () => {
      setPlatform("Win64");
      expect(isWindows()).toBe(true);
    });

    it("returns false on macOS", () => {
      setPlatform("MacIntel");
      expect(isWindows()).toBe(false);
    });
  });

  describe("isLinux", () => {
    beforeEach(() => resetPlatformCache());

    it("returns true on Linux x86_64", () => {
      setPlatform("Linux x86_64");
      expect(isLinux()).toBe(true);
    });

    it("returns true on Linux ARM", () => {
      setPlatform("Linux armv8l");
      expect(isLinux()).toBe(true);
    });

    it("returns true from user-agent for Ubuntu", () => {
      setPlatform("Other", "Mozilla/5.0 (X11; Ubuntu; Linux x86_64)");
      expect(isLinux()).toBe(true);
    });

    it("returns true for NixOS from user-agent", () => {
      setPlatform("Other", "Mozilla/5.0 (X11; NixOS; Linux x86_64)");
      expect(isLinux()).toBe(true);
    });

    it("returns false on macOS", () => {
      setPlatform("MacIntel");
      expect(isLinux()).toBe(false);
    });
  });
});

describe("modKey", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => resetPlatformCache());

  it('returns "⌘" on macOS', () => {
    setPlatform("MacIntel");
    expect(modKey()).toBe("⌘");
  });

  it('returns "Ctrl" on non-macOS', () => {
    setPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(modKey()).toBe("Ctrl");
  });

  it('returns "Ctrl" on Linux', () => {
    setPlatform("Linux x86_64");
    expect(modKey()).toBe("Ctrl");
  });
});

describe("defaultShell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => resetPlatformCache());

  it('returns "zsh" on macOS', () => {
    setPlatform("MacIntel");
    expect(defaultShell()).toBe("zsh");
  });

  it('returns "powershell" on Windows', () => {
    setPlatform("Win32", "Windows NT 10.0");
    expect(defaultShell()).toBe("powershell");
  });

  it('returns "bash" on Linux', () => {
    setPlatform("Linux x86_64");
    expect(defaultShell()).toBe("bash");
  });

  it('returns "bash" on other/unknown', () => {
    setPlatform("");
    expect(defaultShell()).toBe("bash");
  });
});

describe("wrapCommandForPlatform", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => resetPlatformCache());

  it("wraps in bash -c on macOS by default", () => {
    setPlatform("MacIntel");
    const result = wrapCommandForPlatform("ls -la");
    expect(result.program).toBe("zsh");
    expect(result.args).toEqual(["-c", "ls -la"]);
  });

  it("wraps in bash -c on Linux by default", () => {
    setPlatform("Linux x86_64");
    const result = wrapCommandForPlatform("ls -la");
    expect(result.program).toBe("bash");
    expect(result.args).toEqual(["-c", "ls -la"]);
  });

  it("wraps in powershell -Command on Windows by default", () => {
    setPlatform("Win32", "Windows NT 10.0");
    const result = wrapCommandForPlatform("Get-ChildItem");
    expect(result.program).toBe("powershell");
    expect(result.args).toContain("Get-ChildItem");
    expect(result.args).toContain("-NoProfile");
    expect(result.args).toContain("-NonInteractive");
  });

  it("uses supplied shell instead of default when provided", () => {
    setPlatform("MacIntel");
    const result = wrapCommandForPlatform("echo hi", "bash");
    expect(result.program).toBe("bash");
    expect(result.args).toEqual(["-c", "echo hi"]);
  });

  it("uses powershell mode for pwsh shell", () => {
    setPlatform("MacIntel");
    const result = wrapCommandForPlatform("Get-Item .", "pwsh");
    expect(result.program).toBe("pwsh");
    expect(result.args).toContain("-NoProfile");
  });

  it("uses powershell mode when 'powershell' shell is passed on any OS", () => {
    setPlatform("Linux x86_64");
    const result = wrapCommandForPlatform("Write-Output 'hello'", "powershell");
    expect(result.program).toBe("powershell");
    expect(result.args).toContain("-Command");
  });
});

describe("shortcut", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => resetPlatformCache());

  it('renders "⌘K" on macOS for simple key', () => {
    setPlatform("MacIntel");
    expect(shortcut("K")).toBe("⌘K");
  });

  it('renders "⌘⇧K" on macOS with shift', () => {
    setPlatform("MacIntel");
    expect(shortcut("K", { shift: true })).toBe("⇧⌘K");
  });

  it('renders "⌥⌘K" on macOS with alt', () => {
    setPlatform("MacIntel");
    expect(shortcut("K", { alt: true })).toBe("⌥⌘K");
  });

  it("renders 'Ctrl K' on non-macOS", () => {
    setPlatform("Win32", "Windows NT 10.0");
    expect(shortcut("K")).toBe("Ctrl K");
  });

  it("renders 'Ctrl Shift K' on non-macOS with shift", () => {
    setPlatform("Win32", "Windows NT 10.0");
    expect(shortcut("K", { shift: true })).toBe("Shift Ctrl K");
  });

  it("renders 'Alt Ctrl K' on non-macOS with alt", () => {
    setPlatform("Linux x86_64");
    expect(shortcut("K", { alt: true })).toBe("Alt Ctrl K");
  });

  it("renders 'Alt Ctrl Shift P' for full modifier combo on Linux", () => {
    setPlatform("Linux x86_64");
    expect(shortcut("P", { shift: true, alt: true })).toBe("Alt Shift Ctrl P");
  });
});
