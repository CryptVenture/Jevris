# Handoff between sessions

1. In the source session, call `jevris_handoff_export`. Its `capsule` is portable: it may be a portable envelope (`schemaVersion` `jevris-portable-capsule-2`) that carries the capsule inside.
2. Give that object to the receiving session unchanged.
3. In the receiving session, call `jevris_handoff_import` with `capsule` set to it.

The import checks that the workspace matches, that the capsule has not expired, and its shape. It pins the capsule's facts as context. It grants no authority: approvals in the capsule stay history and nothing is run.
