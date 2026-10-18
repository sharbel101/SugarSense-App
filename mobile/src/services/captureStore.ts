/**
 * State of one "take a meal photo" attempt, kept outside any screen so the camera can be started
 * from the very press that asks for it (the floating camera button, the photo widget in the add
 * sheet, "Retake photo") and the Scan screen just picks up the result.
 *
 * Why it is a store and not screen state: on the web a phone browser only opens its camera if the
 * request is made directly inside the tap, so the capture has to start in the button's own handler,
 * before any navigation. Pure (the real camera is injected as `runner`), so plain-Node tests can run it.
 */

export type CaptureSource = 'camera' | 'gallery';
export type CaptureProblem = 'denied' | 'blocked' | 'failed';
export type CaptureOutcome<P> = { kind: 'photo'; photo: P } | { kind: 'cancelled' } | { kind: CaptureProblem };

export type CaptureState<P> = {
  /** `opening`: the camera / picker is up. `processing`: a photo came back and is being prepared. */
  phase: 'idle' | 'opening' | 'processing';
  /** A finished attempt nobody has acted on yet; the Scan screen takes it with `consume()`. */
  outcome: CaptureOutcome<P> | null;
  /** Why the last attempt could not start (shown on the Scan screen); null after any other result. */
  problem: CaptureProblem | null;
  /** The tab to go back to when the person closes the camera without taking a photo. */
  returnTab: string;
  returnOnCancel: boolean;
};

export type CaptureRunner<P> = (source: CaptureSource, markProcessing: () => void) => Promise<CaptureOutcome<P>>;

export function createCaptureStore<P>(runner: CaptureRunner<P>) {
  let state: CaptureState<P> = { phase: 'idle', outcome: null, problem: null, returnTab: 'Home', returnOnCancel: false };
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (next: CaptureState<P>) => {
    state = next;
    listeners.forEach((l) => l());
  };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Starts an attempt. The runner is called synchronously, so the camera is requested inside the
     * caller's tap. A newer attempt makes any older one's late result irrelevant.
     */
    begin(source: CaptureSource, options?: { returnTab?: string; returnOnCancel?: boolean }) {
      const mine = ++generation;
      set({
        phase: 'opening',
        outcome: null,
        problem: null,
        returnTab: options?.returnTab ?? state.returnTab,
        returnOnCancel: options?.returnOnCancel ?? false,
      });
      const done = (outcome: CaptureOutcome<P>) => {
        if (mine !== generation) return;
        set({
          ...state,
          phase: 'idle',
          outcome,
          problem: outcome.kind === 'photo' || outcome.kind === 'cancelled' ? null : outcome.kind,
        });
      };
      let promise: Promise<CaptureOutcome<P>>;
      try {
        promise = runner(source, () => {
          if (mine === generation) set({ ...state, phase: 'processing' });
        });
      } catch {
        done({ kind: 'failed' });
        return;
      }
      promise.then(done, () => done({ kind: 'failed' }));
    },

    /** Hands the finished attempt to whoever acts on it, exactly once. */
    consume(): CaptureOutcome<P> | null {
      const outcome = state.outcome;
      if (outcome) set({ ...state, outcome: null });
      return outcome;
    },
  };
}
