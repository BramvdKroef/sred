// Entry point for the Employees admin tab. Routes between the list view
// (`#employees`) and the per-user detail subview (`#employees/<id>`); the
// real work lives in `./employees/*.js`:
//
//   list.js           — All-employees table + Add-employee + Attach-existing
//                       forms, plus per-row actions (edit, invite, deactivate)
//   add.js            — Add-employee form binding (email-blur lookup +
//                       create/attach mode toggle, comp-type unit flip)
//   attach.js         — Attach-existing form binding (UC-A3 alt flow A3.a)
//   attachment.js     — Inline edit-user expansion: user-fields form, per-
//                       attachment forms, add-attachment, add-comp-row
//   invite-modal.js   — <dialog> showing invite metadata + delivery status
//   detail.js         — User detail subview (attachments, projects, activity)
//   tips.js           — TIP_SPECIFIED / TIP_COMP_TYPE tooltip strings
//
// `public/admin.js`'s `import employees from './admin/employees.js'; employees
// .render(main, ctx)` contract is preserved — only the internal layout
// changed.

import { renderList } from './employees/list.js';
import { renderUserDetail } from './employees/detail.js';

export async function render(main, ctx) {
  if (ctx.state.viewingUserId) return renderUserDetail(main, ctx);
  return renderList(main, ctx);
}
