import type {CreditEvent} from './credit-schema'

export function lifecycle(event:CreditEvent) {
  switch(event.eventType) {
    case 'credit.lead.created':return null
    case 'credit.lead.approved':return {kind:'approved',referenceId:event.data.leadId,reminderNumber:0}
    case 'credit.lead.documents.overdue':return {kind:'documents',referenceId:event.data.collectionLinkId,reminderNumber:event.data.reminderNumber}
    case 'credit.lead.signature.overdue':return {kind:'signature',referenceId:event.data.ccbId,reminderNumber:event.data.reminderNumber}
    case 'credit.lead.reminders.resolved':return {kind:event.data.kind,referenceId:event.data.referenceId,reminderNumber:0}
  }
}
// Resolution markers survive restarts and also suppress late-arriving reminders.
export const resolutionExists = `EXISTS (SELECT 1 FROM credit_lifecycle_events resolution
 WHERE resolution.event_type='credit.lead.reminders.resolved' AND resolution.producer=alert.producer
 AND resolution.lead_id=alert.lead_id AND resolution.kind=alert.kind AND resolution.reference_id=alert.reference_id)`
export const suppressResolvedDeliveries = `UPDATE sailer_deliveries SET status='blocked',last_error_code='reminder_resolved',claim_token=NULL,lease_until_ms=NULL
 WHERE status IN ('pending','processing','blocked','failed') AND event_pk IN
 (SELECT alert.event_pk FROM credit_lifecycle_events alert WHERE alert.event_type IN ('credit.lead.documents.overdue','credit.lead.signature.overdue') AND ${resolutionExists})`
export const suppressExpiredDeliveries = `UPDATE sailer_deliveries SET status='blocked',last_error_code='reminder_expired',claim_token=NULL,lease_until_ms=NULL
 WHERE status IN ('pending','processing','blocked','failed') AND last_error_code IS NOT 'reminder_resolved' AND event_pk IN
 (SELECT e.id FROM credit_events e WHERE json_extract(e.payload,'$.eventType')='credit.lead.documents.overdue'
 AND json_extract(e.payload,'$.data.thresholdHours')!=24
 AND julianday(json_extract(e.payload,'$.data.expiresAt'))<=julianday(?))`
