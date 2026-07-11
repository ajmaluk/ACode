import { describe, it, expect, beforeEach } from "vitest";
import { useGit, useCommandPalette } from "../../store/useAppStore";

describe("useGit store", () => {
  beforeEach(() => {
    useGit.setState({ status: null, loading: false, error: null });
  });

  it("initializes with default state", () => {
    const state = useGit.getState();
    expect(state.status).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("sets loading state", () => {
    useGit.setState({ loading: true });
    expect(useGit.getState().loading).toBe(true);
  });

  it("sets error state", () => {
    useGit.setState({ error: "not_initialized" });
    expect(useGit.getState().error).toBe("not_initialized");
  });

  it("sets git status", () => {
    const mockStatus = {
      branch: "main",
      added: ["file1.ts"],
      deleted: [],
      modified: [],
      untracked: [],
      ahead: 1,
      behind: 0,
    };
    useGit.setState({ status: mockStatus });
    expect(useGit.getState().status).toEqual(mockStatus);
    expect(useGit.getState().status!.branch).toBe("main");
  });

  it("resets loading and error when status is set", () => {
    useGit.setState({ loading: true, error: "some error" });
    useGit.setState({
      status: {
        branch: "main",
        added: [],
        deleted: [],
        modified: [],
        untracked: [],
        ahead: 0,
        behind: 0,
      },
      loading: false,
      error: null,
    });
    const state = useGit.getState();
    expect(state.status).not.toBeNull();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("preserves equality of state objects", () => {
    const state1 = useGit.getState();
    const state2 = useGit.getState();
    expect(state1).toBe(state2);
  });
});

describe("useCommandPalette store", () => {
  beforeEach(() => {
    useCommandPalette.getState().setOpen(false);
  });

  it("initializes with closed state", () => {
    const state = useCommandPalette.getState();
    expect(state.open).toBe(false);
    expect(state.query).toBe("");
  });

  it("sets open to true", () => {
    useCommandPalette.getState().setOpen(true);
    expect(useCommandPalette.getState().open).toBe(true);
  });

  it("sets open to false and clears query", () => {
    useCommandPalette.getState().setQuery("test");
    useCommandPalette.getState().setOpen(false);
    const state = useCommandPalette.getState();
    expect(state.open).toBe(false);
    expect(state.query).toBe("");
  });

  it("sets query", () => {
    useCommandPalette.getState().setQuery("search term");
    expect(useCommandPalette.getState().query).toBe("search term");
  });

  it("toggles from closed to open", () => {
    useCommandPalette.getState().toggle();
    expect(useCommandPalette.getState().open).toBe(true);
  });

  it("toggles from open to closed", () => {
    useCommandPalette.getState().setOpen(true);
    useCommandPalette.getState().toggle();
    expect(useCommandPalette.getState().open).toBe(false);
  });

  it("clears query on toggle", () => {
    useCommandPalette.getState().setQuery("something");
    useCommandPalette.getState().toggle();
    expect(useCommandPalette.getState().query).toBe("");
  });

  it("preserves query when opening programmatically", () => {
    useCommandPalette.getState().setQuery("my-search");
    useCommandPalette.getState().setOpen(true);
    const state = useCommandPalette.getState();
    expect(state.query).toBe("my-search");
    expect(state.open).toBe(true);
  });
});
