/**
 * The widget's stylesheet, injected as an inline `<style>` inside the widget's
 * shadow root — so Meet's global CSS neither leaks in nor is inherited, and the
 * widget carries no global `content_scripts` `css:` entry. Ported from Variant A
 * of the #4 shell prototype (`prototypes/widget-shell/`): a floating card
 * anchored top-centre that folds to a pill in the middle of Meet's top bar.
 */
export const WIDGET_STYLE = `
  :host {
    --surface: #303134;
    --border: #3c4043;
    --on: #34a853;
    --off: #5f6368;
    --text: #e8eaed;
    --text-dim: #9aa0a6;
    --radius: 12px;
    all: initial;
  }
  * { box-sizing: border-box; }

  .card {
    position: fixed; top: 8px; left: 50%; transform: translateX(-50%); width: 260px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 8px 28px rgba(0,0,0,.5);
    font-family: "Google Sans", Roboto, system-ui, sans-serif; font-size: 13px;
    color: var(--text); z-index: 2147483000; transition: width .15s;
  }
  .head {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px;
    border-bottom: 1px solid var(--border); cursor: pointer; user-select: none;
  }
  .head b { font-weight: 500; flex: 1; }
  .grip { color: var(--text-dim); }
  .chev { color: var(--text-dim); font-size: 11px; transition: transform .15s; }
  .body { padding: 6px 12px 12px; }

  /* folded: shrink to a compact pill, header only */
  .card.folded { width: auto; }
  .card.folded .head { border-bottom: none; border-radius: var(--radius); padding: 8px 14px; }
  .card.folded .grip { display: none; }
  .card.folded .chev { transform: rotate(-90deg); }
  .card.folded .body { display: none; }

  .row {
    display: flex; align-items: center; gap: 10px; padding: 9px 0;
    border-bottom: 1px solid rgba(255,255,255,.05);
  }
  .row:last-child { border-bottom: none; }
  .row .lbl { flex: 1; }
  .row .lbl small { display: block; color: var(--text-dim); font-size: 11px; }

  .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #3c4043; color: var(--text-dim); }

  .midiList { margin: 4px 0 0 0; padding: 8px 10px; background: rgba(0,0,0,.25); border-radius: 8px; }
  .midiList label { display: flex; align-items: center; gap: 8px; padding: 3px 0; color: var(--text-dim); cursor: pointer; }
  .midiList label.on { color: var(--text); }
  .midiEmpty { color: var(--text-dim); font-size: 12px; padding: 2px 0; }

  /* toggle switch */
  .sw { position: relative; width: 34px; height: 18px; flex: none; }
  .sw input { opacity: 0; width: 0; height: 0; }
  .sw .track {
    position: absolute; inset: 0; border-radius: 999px; background: var(--off);
    transition: background .15s; cursor: pointer;
  }
  .sw .track::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
    border-radius: 50%; background: #fff; transition: transform .15s;
  }
  .sw input:checked + .track { background: var(--on); }
  .sw input:checked + .track::after { transform: translateX(16px); }
`;
