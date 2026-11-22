select *
from {{ ref('evidence') }}
where evidence_score not between 0 and 100
    or relevance_score not between 0 and 100
    or not case source
        when 'pubmed' then regexp_full_match(pmid, '[0-9]+')
        when 'clinicaltrials' then regexp_full_match(source_id, 'NCT[0-9]{8}')
        when 'openfda' then try_cast(source_id as uuid) is not null
        else false
    end
