// Entry for the Projects tab. The list-vs-detail split lives in two
// sibling modules; this file just routes by state.viewingProjectId and
// keeps the `projects.render(main, ctx)` surface that public/admin.js
// imports.
import { renderClaimantsTab, bindList } from './projects/list.js';
import { renderProjectDetail } from './projects/detail.js';

export async function render(main, ctx) {
  if (ctx.state.viewingProjectId) return renderProjectDetail(main, ctx);
  main.innerHTML = renderClaimantsTab(ctx);
  bindList(ctx);
}
