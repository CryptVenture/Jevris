# Receipts

A receipt is written only by the Jevris runner when a check runs from the jevris CLI (`jevris verify`). It records the check, the revision and the outcome.

Linking an existing receipt to a check (`jevris_record_verification`) records only a pointer. It cannot create a receipt or change an outcome.

A receipt counts only for the revision it was recorded on. After a change, run the checks again.
