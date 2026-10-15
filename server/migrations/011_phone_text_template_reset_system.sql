-- 009/010 ran without the system flag, so row-level security hid every row and nothing was reset.
select set_config('app.system', 'on', true);
update phone_text_batches set template = null where template is not null;
