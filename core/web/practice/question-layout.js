// Old drafts have no layout metadata: preserve their original card coordinates.
export const LEGACY_DRAFT_LAYOUT = Object.freeze({width:760,padding:26,top:34});
export function syncQuestionLayout(pane, draft) {
  if (draft && pane.draftLayoutPending && !pane.loading && pane.view==='practice') {
    // New drafts use device-independent logical coordinates. Existing layout
    // metadata is retained so older annotations keep their alignment.
    if (pane.whiteboard.initializeLayout(LEGACY_DRAFT_LAYOUT.width)) pane.draftLayoutPending=false;
  }
  const layout=(pane.whiteboard.getLayout ? pane.whiteboard.getLayout() : pane.whiteboard.getDraft?.()?.layout)||LEGACY_DRAFT_LAYOUT;
  pane.world.style.setProperty('--qf-draft-width',`${layout.width}px`);
  pane.world.style.setProperty('--qf-draft-padding',`${layout.padding}px`);
  pane.world.style.setProperty('--qf-draft-top',`${layout.top}px`);
  pane.whiteboard.setViewCamera({x:0,y:0,zoom:1});
  return layout;
}
