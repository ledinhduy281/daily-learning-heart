with deduped as (
    select *
    from {{ ref('stg_evidence') }}
    qualify row_number() over (
        partition by source, source_id
        order by source_date desc nulls last, title, study_type, journal, topic_text
    ) = 1
),

classified as (
    select *,
        case
            when regexp_matches(topic_text, 'pulmonary hypertension|venous thromboembol|pulmonary embol|aortic aneurysm|aortic dissection') then 'pulmonary_vascular_aortic'
            when regexp_matches(topic_text, 'cardiomyopath|pericard|congenital heart') then 'cardiomyopathy_pericardial_congenital'
            when regexp_matches(topic_text, 'endocarditis|valvular|aortic stenosis|mitral|tricuspid|\btavr\b|\btavi\b') then 'valvular_endocarditis'
            when regexp_matches(topic_text, 'atrial fibrillation|arrhythmia|electrophysiolog|syncope|tachycardia|ablation') then 'arrhythmia'
            when regexp_matches(topic_text, 'heart failure|cardiogenic shock|\bhfref\b|\bhfpef\b') then 'heart_failure'
            when regexp_matches(topic_text, 'anticoagula|antiplatelet|antithrombo|clopidogrel|apixaban|rivaroxaban') then 'antithrombotic'
            when regexp_matches(topic_text, 'coronary|myocardial infarct|angina|ischemic heart') then 'coronary_disease'
            when regexp_matches(topic_text, 'dyslipid|atherosclero|cholesterol|\bldl\b|statin') then 'lipids_atherosclerosis'
            when regexp_matches(topic_text, '\bhypertension\b|blood pressure') then 'hypertension_risk'
            else 'general_cardiology'
        end as topic,
        case
            when source = 'openfda' then 'drug_label'
            when source = 'clinicaltrials' then 'trial_registry'
            when regexp_matches(lower(study_type), 'guideline') then 'guideline'
            when regexp_matches(lower(study_type), 'meta-analysis|systematic review') then 'evidence_synthesis'
            when regexp_matches(lower(study_type), 'randomized controlled trial') then 'randomized_trial'
            when regexp_matches(lower(study_type), 'clinical trial|observational study') then 'clinical_study'
            else 'other_publication'
        end as evidence_type,
        case
            when lower(journal) in ('n engl j med', 'lancet', 'jama', 'circulation', 'j am coll cardiol', 'eur heart j')
                then 'selected_journal'
            when journal is not null then 'other_journal'
            else 'not_applicable'
        end as journal_tier
    from deduped
)

select *,
    case evidence_type
        when 'guideline' then 90
        when 'evidence_synthesis' then 85
        when 'randomized_trial' then 80
        when 'clinical_study' then 55
        when 'other_publication' then 30
        else 20
    end + case when journal_tier = 'selected_journal' then 10 else 0 end as evidence_score,
    case when topic = 'general_cardiology' then 20 else 60 end
        + case
            when date_diff('day', source_date, date '{{ env_var("HEART_RUN_DATE") }}') between 0 and 30 then 40
            when date_diff('day', source_date, date '{{ env_var("HEART_RUN_DATE") }}') between 31 and 90 then 20
            else 0
        end as relevance_score
from classified
