-- Lists copied with "Send again" before this fix could carry an old text. All lists now follow Settings.
update phone_text_batches set template = null where template is not null;
