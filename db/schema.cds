namespace gov;

using { cuid } from '@sap/cds/common';

// Reference data standing in for the S/4 maintenance backend.
entity Materials {
  key ID   : Integer;
  name     : String(80);
  unit     : String(3);
}

entity MaterialStockLevels : cuid {
  material        : Association to Materials;
  plant           : String(4);
  storageLocation : String(4);
  quantity        : Decimal(13, 3);
}

entity MaintenanceOrders {
  key ID      : Integer;
  description : String(120);
  plant       : String(4);
  status      : String(20);
  operations  : Composition of many OrderOperations on operations.order = $self;
}

entity OrderOperations {
  key ID      : Integer;
  order       : Association to MaintenanceOrders;
  description : String(120);
  components  : Composition of many OperationComponents on components.operation = $self;
}

entity OperationComponents : cuid {
  operation   : Association to OrderOperations;
  material    : Association to Materials;
  requiredQty : Decimal(13, 3);
}

// Every lookup and every verdict is written here, so any answer the agent
// gives can be traced back to the exact data and arithmetic behind it.
entity AuditLog : cuid {
  timestamp     : Timestamp;
  correlationID : String(80);
  outcome       : String(10);   // OK | DENIED | ERROR
  httpStatus    : Integer;
  caller        : String(120);
  tool          : String(60);
  input         : LargeString;
  output        : LargeString;
}
