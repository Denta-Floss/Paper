'use strict';

// ---------------------------------------------------------------------------
// What other modules ask of inventory, written down once.
//
// Each row is one function in ./ports.js: its place there, the names of its
// arguments in order, and whether it has to run inside the caller's open
// transaction. The operation is named after the port unless `as` says
// otherwise (it does where a user operation already has the name). Two things are built from this list and so cannot drift apart:
//
//   ./operations.js   publishes each as an internal operation at the kernel
//                     desk, `inventory.<port>`, with the arguments by name;
//   ./client.js       gives a calling module an object shaped like the ports
//                     that asks the desk instead of calling inventory directly.
//
// `joins` marks an operation as joining the caller's transaction: issuing a
// challan, settling one, deleting an order line and handing a job to a worker
// all change stock inside a transaction they opened. Those are what will stop
// inventory being put in a separate process from its callers.
// ---------------------------------------------------------------------------

module.exports = [
  // The stock ledger's one write path.
  { port: 'movements.apply', args: ['movement'],
    summary: 'Receive, issue, transfer or adjust stock, in its own transaction.' },
  { port: 'movements.applyCore', args: ['movement', 'options'], joins: true,
    summary: 'The same, inside the caller’s transaction (options.useTransaction false).' },

  // Challans adjust the item's stock themselves, so they write the ledger rows
  // and mint materials directly rather than through the movement engine.
  { port: 'movements.recordForChallan', args: ['args'], joins: true,
    summary: 'The ledger row for an issued challan line.' },
  { port: 'movements.forChallan', args: ['challanId', 'challanType'],
    summary: 'The ledger rows a cancel or delete of a challan must undo.' },
  { port: 'movements.recordChallanReversal', args: ['args'], joins: true,
    summary: 'The ledger row that undoes one of a challan’s.' },
  { port: 'movements.producedLotCodeForRun', args: ['pipelineRunId'],
    summary: 'The lot a pipeline run last produced.' },
  { port: 'receipts.mintFromChallanLine', args: ['args'], joins: true,
    summary: 'A reception line becomes a material with a stock position.' },
  { port: 'receipts.mintReconcileLot', args: ['args'], joins: true,
    summary: 'The lot an in-use settle receives into.' },
  { port: 'receipts.usageForChallan', args: ['challanId'],
    summary: 'What a reception brought in and how much of it stock still holds.' },
  { port: 'receipts.materialForChallanLine', args: ['lineId'],
    summary: 'The material a reception line became.' },
  { port: 'receipts.retire', args: ['barcode', 'now'], joins: true,
    summary: 'A cancelled reception’s material stops being listed as stock.' },

  // Production.
  { port: 'receipts.mintLot', args: ['args'],
    summary: 'A lot production made: finished output, or scrap off a stage.' },
  { port: 'sets.recordProduced', args: ['args'],
    summary: 'The temporary set an Assembly stage produced, with its stock.' },
  { port: 'sources.forItem', args: ['itemId', 'leafNodeId'],
    summary: 'The barcodes that hold free stock of an item and variation, oldest first.' },
  { port: 'sources.propose', args: ['sources', 'quantity'],
    summary: 'Where a quantity comes from among those barcodes, oldest first.' },
  { port: 'scans.increment', args: ['barcode'],
    summary: 'Count a scan against a material.' },
  { port: 'ledger.recomputeSummary', args: ['barcode', 'now'],
    summary: 'Re-derive a material’s on-hand figures from its stock positions.' },
  { port: 'materials.rowByBarcode', args: ['barcode'],
    summary: 'A material’s row by its barcode, however the barcode is written, or nothing.' },

  // Items and the action centre (their code is still in server.js and still
  // calls the ports directly; these are here for when it moves).
  { port: 'sets.deleteById', args: ['setId'], summary: 'Remove a set and its links.' },
  { port: 'sets.removeLinesForItem', args: ['itemId'], summary: 'Take an item out of every set.' },
  { port: 'sets.membershipForItem', args: ['itemId'], summary: 'The sets an item is in, with its quantity in each.' },
  // `as`: the user operation inventory.materials.delete already has that name.
  { port: 'materials.delete', as: 'materials.deleteRecord', args: ['barcode'], summary: 'Remove a material.' },
  { port: 'governance.get', args: ['materialId'], summary: 'A material’s group-inheritance configuration.' },
  { port: 'governance.retireMissingProperties', args: ['args'], summary: 'Retire group properties a save dropped.' },
];
