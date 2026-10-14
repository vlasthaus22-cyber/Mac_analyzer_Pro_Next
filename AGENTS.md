# MAC Analyzer Pro Next engineering guide

- Browser-only functionality is the primary product path.
- Domain logic belongs in `src/core`; IndexedDB code belongs in `src/data`.
- UI modules must not create, merge, or mutate device identity directly.
- DDIO may fill a blank device IP by exact MAC, but never creates Final devices.
- Final and Inventory are separate entities.
- A new Final becomes active only after one successful IndexedDB transaction.
- Empty values must never overwrite known non-empty values.
- Generated files under `dist/` are built by `pnpm build` and are not edited.
- Add a regression test for every repaired user-facing defect.
- Run `pnpm check` and `pnpm build` before release.

