import { ApiError, bad } from '../platform/errors.js';
import { integralField, jsonBytes } from '../platform/json.js';

function finite(value, min, max) { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function color(value) { return typeof value === 'string' && /^#[a-fA-F0-9]{3,8}$/.test(value); }
export function validateDraft(draft) {
  const invalid = () => { throw bad('Invalid whiteboard draft'); };
  if (!draft || !integralField(draft, 'schemaVersion') || draft.schemaVersion !== 1 || !draft.viewport || !draft.paper || !Array.isArray(draft.strokes) || draft.strokes.length > 2000) invalid();
  if (!finite(draft.viewport.x, -1e6, 1e6) || !finite(draft.viewport.y, -1e6, 1e6) || !finite(draft.viewport.zoom, .25, 4) || !color(draft.paper.color) || !['plain', 'none', 'grid', 'dots', 'ruled', 'lines', 'lined'].includes(draft.paper.pattern)) invalid();
  if (Object.hasOwn(draft,'layout')) {
    const layout=draft.layout;
    if (!layout || typeof layout!=='object' || Array.isArray(layout) || Object.keys(layout).some(key=>!['width','padding','top'].includes(key)) || !finite(layout.width,100,10000) || !finite(layout.padding,0,100) || !finite(layout.top,0,200)) invalid();
  }
  const seen = new Set(); let total = 0;
  for (const stroke of draft.strokes) {
    if (typeof stroke?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(stroke.id) || seen.has(stroke.id) || !color(stroke.color) || !finite(stroke.width, .5, 32) || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 10000 || (total += stroke.points.length) > 100000) invalid();
    seen.add(stroke.id);
    for (const point of stroke.points) if (!finite(point?.x, -1e6, 1e6) || !finite(point.y, -1e6, 1e6) || !finite(point.pressure, 0, 1)) invalid();
  }
  if (jsonBytes(draft).length > 8 * 1024 * 1024) throw new ApiError(413, 'DRAFT_SIZE_LIMIT', 'Whiteboard draft exceeds the size limit');
}
