import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  index: 0,
  version: 1 as number | undefined,
  options: null as any,
  invalidate: vi.fn(),
}));
vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const index = state.index++;
    return (state.refs[index] ??= { current: initial });
  },
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => {
    state.options = options;
    return { data: state.version === undefined ? undefined : { version: state.version } };
  },
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
import { useWorkspaceChanges } from "./useWorkspaceChanges";
const client = {
  getServerUrl: () => "local",
  workspaceVersion: async () => ({ version: state.version! }),
} as any;
function render(version: number | undefined, editing = false, enabled = true) {
  state.index = 0;
  state.version = version;
  useWorkspaceChanges(client, enabled, editing);
}
function keys() {
  return state.invalidate.mock.calls.map(([input]) => input.queryKey[0]);
}
beforeEach(() => {
  state.refs = [];
  state.index = 0;
  state.invalidate.mockClear();
});
describe("external workspace change observation", () => {
  it("refreshes warm caches on first observation and later external changes without remote sync", () => {
    render(1);
    expect(keys()).toContain("tree");
    expect(keys()).toContain("note");
    state.invalidate.mockClear();
    render(1);
    expect(keys()).toEqual([]);
    render(2);
    expect(keys()).toContain("tree");
    expect(keys()).toContain("note");
    expect(state.options.refetchInterval).toBe(2000);
    expect(state.options.refetchIntervalInBackground).toBe(false);
  });
  it("refreshes structure while editing but defers note refresh until editing ends", () => {
    render(1);
    state.invalidate.mockClear();
    render(2, true);
    expect(keys()).toContain("tree");
    expect(keys()).not.toContain("note");
    state.invalidate.mockClear();
    render(2, false);
    expect(keys()).toEqual(["note"]);
  });
  it("does not poll or invalidate without access and refreshes when access returns", () => {
    render(undefined, false, false);
    expect(state.options.enabled).toBe(false);
    expect(keys()).toEqual([]);
    render(3);
    expect(keys()).toContain("tree");
  });
});
