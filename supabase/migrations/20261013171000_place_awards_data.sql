-- Michelin marks confirmed on guide.michelin.com (2026-10-13). Admin data, not schema.
update public.hanjogo_alumni_places p set michelin=v.m, michelin_year=v.y
from (values (12,'LÉGUME','1star',2026),(44,'Jua','1star',2025),(67,'moono','selected',null::int),(31,'오부이용','selected',2026)) v(id,name,m,y)
where p.id=v.id and p.name=v.name;
