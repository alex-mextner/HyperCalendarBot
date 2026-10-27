// Event tool handlers. The implementations live in ./events/ (read, create, update, delete,
// attach-location, notify-participants, with presentation/range/group-notifications helpers); this
// module is the stable import path the tool executor, the day-reference guard and the tests use.
export { handleAttachPendingLocationToEvent } from './events/attach-location.ts';
export { handleCreateEvent } from './events/create.ts';
export { handleDeleteConfirmationRequest, handleDeleteEvent } from './events/delete.ts';
export { handleNotifyParticipants } from './events/notify-participants.ts';
export { localDaysForUtcDayEdges } from './events/range.ts';
export { handleGetEvent, handleGetEvents, handleGetUpcoming, handleSearchEvents } from './events/read.ts';
export type { AttachPendingLocationInput } from './events/types.ts';
export { handleSnoozeEvent, handleUpdateEvent } from './events/update.ts';
