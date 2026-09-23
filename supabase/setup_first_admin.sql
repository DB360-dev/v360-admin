-- Run ONCE in the Supabase SQL Editor, after 001-003.
-- Before running: Supabase dashboard -> Authentication -> Users -> "Add user"
-- and create your own login (e.g. saad@v360.pk). Then replace the email below.

insert into organizations (name, type, slug) values
  ('V360', 'v360', 'v360'),
  ('KBB',  'partner', 'kbb');

insert into memberships (user_id, organization_id, role)
select u.id, o.id, 'admin'
from auth.users u, organizations o
where u.email = 'saad@v360.pk'      -- <-- your email
  and o.type = 'v360';

-- Check: should return one row with role 'admin'
select u.email, o.name, m.role
from memberships m join auth.users u on u.id = m.user_id join organizations o on o.id = m.organization_id;
