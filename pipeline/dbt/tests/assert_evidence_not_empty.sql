select count(*) as record_count
from {{ ref('evidence') }}
having count(*) = 0
