select proname from pg_proc where proname in ('check_email_has_orders','can_access_app','validate_user_access','validate_signup_has_order');

select tgname, tgrelid::regclass
from pg_trigger
where tgname = 'trg_validate_signup';
