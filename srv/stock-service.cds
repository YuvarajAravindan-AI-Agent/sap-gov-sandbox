using { gov } from '../db/schema';

@path: '/stock'
service StockService {

  // The five lookups the Joule skills called, as read-only functions.
  @requires: 'agent'
  function getMaintenanceOrderDetails(orderID : Integer) returns LargeString;
  @requires: 'agent'
  function getOrderOperations(orderID : Integer)         returns LargeString;
  @requires: 'agent'
  function getOperationComponents(operationID : Integer) returns LargeString;
  @requires: 'agent'
  function getMaterialDetails(materialID : Integer)      returns LargeString;
  @requires: 'agent'
  function getMaterialStockLevels(materialID : Integer)  returns LargeString;

  // Stock arithmetic done in code, never by the language model.
  @requires: 'agent'
  function validateOrderStock(orderID : Integer)         returns LargeString;

  @readonly @restrict: [{ grant: 'READ', to: 'auditor' }]
  entity AuditLog as projection on gov.AuditLog;
}
