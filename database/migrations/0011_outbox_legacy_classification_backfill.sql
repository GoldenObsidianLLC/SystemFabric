-- SystemFabric 0.5.2: keep unregistered legacy outbox event types internal.
-- New event types must be added to the reviewed DOMAIN_EVENT_CLASSIFICATIONS
-- registry before they can claim site-private or public classification.

UPDATE outbox_events
   SET classification = 'internal'
 WHERE classification = 'site-private'
   AND event_type NOT IN (
     'content.upsert',
     'content.publish',
     'content.unpublish',
     'content.delete',
     'content.submitted_for_review',
     'content.approved',
     'content.rejected',
     'content.scheduled',
     'content.archived',
     'content.unpublished',
     'relationship.upsert',
     'relationship.delete',
     'taxonomy.upsert',
     'taxonomy.delete'
   );
