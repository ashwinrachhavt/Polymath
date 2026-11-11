# speech

Owns: dictation, the spoken words a person inserts into a text field

No tables. A dictation clip is transcribed through the transcription seam
(`src/integrations/transcription/`), admitted through the provider quota
ledger, audited once per attempt, and returned as text. The audio and the
transcript are never stored: the clip lives only in the request, and the words
land wherever the person's caret was, as editable text.
