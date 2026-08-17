-- Run manually in the Supabase SQL editor when API slow-query logs appear.
-- This is intentionally not executed by the application or migrations.
-- Reset statistics only from an approved maintenance session; this query is read-only.

select
  queryid,
  calls,
  round(total_exec_time::numeric, 1) as total_exec_ms,
  round(mean_exec_time::numeric, 1) as mean_exec_ms,
  round(max_exec_time::numeric, 1) as max_exec_ms,
  rows,
  left(regexp_replace(query, '\s+', ' ', 'g'), 240) as query_sample
from pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database())
  and query not ilike '%pg_stat_statements%'
order by total_exec_time desc
limit 25;
