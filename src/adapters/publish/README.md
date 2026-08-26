# UI publisher adapters

Implementation wave W4.

Each platform adapter must separate:
1. `prepare()` — reversible navigation/upload/form-fill,
2. `invokeFinalAction()` — irreversible publish action behind hard gates.

Unknown UI state fails closed. A publisher never returns a `VerifiedPublication`; verification is separate.
