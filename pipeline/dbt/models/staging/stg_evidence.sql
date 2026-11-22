{% set bronze_dir = env_var('HEART_BRONZE_DIR') | replace("'", "''") %}

{% for source in ['pubmed', 'clinicaltrials', 'openfda'] %}
select
    '{{ source }}' as source,
    trim(source_id) as source_id,
    nullif(trim(title), '') as title,
    source_date,
    nullif(trim(journal), '') as journal,
    nullif(trim(study_type), '') as study_type,
    lower(concat_ws(' ', title, topic_text)) as topic_text,
    source_url
from read_parquet('{{ bronze_dir }}/{{ source }}.parquet', hive_partitioning = false)
{% if not loop.last %}union all{% endif %}
{% endfor %}
