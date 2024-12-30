export * from './wizard';//
export * from './models';
export * from './report';

export async function _preInitCleanM2mModels(cr) {
    await cr.execute('DROP TABLE IF EXISTS "accountJournalAccountReportPartnerLedgerRel"');
}