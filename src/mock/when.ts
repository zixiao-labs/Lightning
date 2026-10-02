import { deepEqual } from "../utils/equality.ts";
import type { MockInstance } from "./index.ts";

type Fn = (...args: any[]) => any;
export interface WhenOptions<T extends Fn> { onUnmatched?: "throw" | T }
export interface ActionOptions { times?: number }
export interface WhenChain<T extends Fn> {
  calledWith(...args: Parameters<T>): this;
  thenReturn(value: ReturnType<T>, options?: ActionOptions): this;
  thenResolve(value: Awaited<ReturnType<T>>, options?: ActionOptions): this;
  thenThrow(error: unknown, options?: ActionOptions): this;
  thenReject(error: unknown, options?: ActionOptions): this;
  thenReturnOnce(value: ReturnType<T>): this;
  thenResolveOnce(value: Awaited<ReturnType<T>>): this;
  thenThrowOnce(error: unknown): this;
  thenRejectOnce(error: unknown): this;
  readonly exhausted: boolean;
  [Symbol.dispose](): void;
}
interface Action { run: Fn; times: number; used: number }
interface Behavior { args: unknown[]; actions: Action[] }
interface State {
  behaviors: Behavior[];
  fallback: Fn | undefined;
  unmatched: "throw" | Fn | undefined;
  wrapper: Fn;
}
const states = new WeakMap<MockInstance, State>();
const chains = new WeakSet<object>();

export function isWhenChain(value: unknown): value is WhenChain<Fn> {
  return typeof value === "object" && value !== null && chains.has(value);
}
export function resetWhen(mock: MockInstance): void { states.delete(mock); }

/** Behaviors match FIFO; actions stack LIFO, exactly like Vitest 5 vi.when. */
export function when<T extends Fn>(mock: MockInstance<T>, options: WhenOptions<T> = {}): WhenChain<T> {
  if (!mock?._isMockFunction) throw new TypeError("vi.when expects a mock function or spy");
  let state = states.get(mock);
  if (!state) {
    state = { behaviors: [], fallback: mock.getMockImplementation(), unmatched: undefined, wrapper: () => {} };
    const current = state;
    current.wrapper = function (this: unknown, ...args: unknown[]) {
      const behavior = current.behaviors.find((entry) => deepEqual(args, entry.args));
      const action = behavior?.actions.findLast((entry) => entry.used < entry.times);
      if (action) { action.used++; return action.run.apply(this, args); }
      if (current.unmatched === "throw") {
        throw new Error(`vi.when: no behavior defined when called with ${JSON.stringify(args)}`);
      }
      const fallback = typeof current.unmatched === "function" ? current.unmatched : current.fallback;
      return fallback?.apply(this, args);
    };
    states.set(mock, current);
    mock.mockImplementation(current.wrapper as T);
  }
  const current = state;
  if (options.onUnmatched !== undefined) current.unmatched = options.onUnmatched;
  const ownActions = new Set<Action>();
  const ownBehaviors = new Set<Behavior>();
  let selected: Behavior | undefined;
  let disposed = false;
  function add(run: Fn, actionOptions: ActionOptions = {}): WhenChain<T> {
    if (!selected || disposed) throw new Error("Call calledWith before adding an action to vi.when");
    const times = actionOptions.times ?? Number.POSITIVE_INFINITY;
    if (times !== Number.POSITIVE_INFINITY && (!Number.isInteger(times) || times < 1)) {
      throw new Error("vi.when action times must be a positive integer");
    }
    const action = { run, times, used: 0 };
    selected.actions.push(action);
    ownActions.add(action);
    return chain;
  }
  const chain: WhenChain<T> = {
    calledWith(...args) {
      if (disposed) throw new Error("vi.when chain has been disposed");
      selected = current.behaviors.find((entry) => deepEqual(args, entry.args));
      if (!selected) { selected = { args, actions: [] }; current.behaviors.push(selected); }
      ownBehaviors.add(selected);
      return this;
    },
    thenReturn: (value, opts) => add(() => value, opts),
    thenResolve: (value, opts) => add(() => Promise.resolve(value), opts),
    thenThrow: (error, opts) => add(() => { throw error; }, opts),
    thenReject: (error, opts) => add(() => Promise.reject(error), opts),
    thenReturnOnce: value => add(() => value, { times: 1 }),
    thenResolveOnce: value => add(() => Promise.resolve(value), { times: 1 }),
    thenThrowOnce: error => add(() => { throw error; }, { times: 1 }),
    thenRejectOnce: error => add(() => Promise.reject(error), { times: 1 }),
    get exhausted() {
      return ownActions.size > 0 && [...ownBehaviors].every((entry) => entry.actions.length > 0)
        && [...ownActions].every((entry) => entry.times === Number.POSITIVE_INFINITY ? entry.used > 0 : entry.used >= entry.times);
    },
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      for (const behavior of current.behaviors) behavior.actions = behavior.actions.filter((action) => !ownActions.has(action));
      current.behaviors = current.behaviors.filter((behavior) => behavior.actions.length);
      if (!current.behaviors.length) {
        if (mock.getMockImplementation() === current.wrapper) mock.mockImplementation(current.fallback as T);
        states.delete(mock);
      }
    },
  };
  chains.add(chain);
  return chain;
}
