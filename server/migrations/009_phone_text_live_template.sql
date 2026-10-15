-- Lists use the current Settings text at the moment each person is opened, so editing the text
-- in Settings applies to lists already made. A list keeps its own text only if one was given for it.
alter table phone_text_batches alter column template drop not null;
update phone_text_batches set template = null;
