select
    concat(source, ':', source_id) as evidence_id,
    source,
    source_id,
    case when source = 'pubmed' then source_id end as pmid,
    title,
    source_date,
    source_url,
    journal,
    study_type,
    topic,
    evidence_type,
    journal_tier,
    evidence_score,
    relevance_score
from {{ ref('int_evidence') }}
