export type Batch = { id:string; expiry:string; stock:number; cost:number }
export type Product = { id:string; name:string; generic:string; category:string; batch:string; expiry:string; stock:number; reorder:number; cost:number; price:number; supplier:string; batches:Batch[] }
export type Purchase = { id:string; date:string; supplier:string; product:string; qty:number; amount:number; status:'Posted'|'Draft'; batch:string; expiry:string; unitCost:number }
export type PurchaseReturnLine = { product:string; pack:string; batch:string; expiry:string; rate:number; qty:number; bonus:number; discount:number; gst:number }
export type PurchaseReturn = { id:string; date:string; supplier:string; reference:string; supplierBill:string; paymentType:'Cash'|'Credit'; status:'Draft'|'Posted'|'Referenced'|'Cancelled'; remarks:string; lines:PurchaseReturnLine[]; amount:number }
export type Sale = { id:string; date:string; customer:string; product:string; qty:number; amount:number; mode:string; status:'Paid'|'Credit'; batch:string; unitCost:number }
export type StockMovement = { id:string; date:string; product:string; batch:string; type:'Purchase'|'Purchase Return'|'Sale'|'Gift'|'Breakage'|'Transfer'|'Stock In'|'Issue'|'Adjustment'|'Count'; qty:number; reference:string; from?:string; to?:string; note?:string; expiry?:string; unitCost?:number }
export type Journal = { id:string; date:string; description:string; debit:string; credit:string; amount:number; reference:string }
export type UserAccount = { id:string; name:string; role:string; branch:string; email:string;
  twoFactor:boolean; status:'Active'|'Away'|'Suspended'; lastActive:string; modules:string[];
  sessions:{ device:string; location:string; lastActive:string; ip:string }[];
  audit:{ date:string; action:string; detail:string; user:string }[] }
export type Master = { code:string; name:string; type:string; balanceType:string; status:string; city:string; contact:string; balance:number; level?:number; parent?:string|null; extra?:Record<string,string> }
export type ReportDef = { slug:string; name:string; description:string; icon:string; category:string; source:string; columns:{key:string;label:string}[]; filters?:Record<string,string> }
export type ColDef = { key:string; label:string }
export type VoucherLine = { debit:string; credit:string; amount:number; remark?:string }
export type Voucher = { id:string; date:string; type:'JV'|'CRV'|'CPV'|'BRV'|'BPV'|'CV'|'SINV'|'PINV'; narration:string; reference:string; status:'Posted'|'Draft'|'Cancelled'; posting:'Posted'|'Unposted'; createdBy:string; branch:string; department:string; lines:VoucherLine[] }
export type PurchaseOrderLine = { product:string; qty:number; cost:number }
export type PurchaseOrder = { id:string; date:string; supplier:string; lines:PurchaseOrderLine[]; amount:number; status:'Draft'|'Pending'|'Approved'|'Sent'|'Received'|'Cancelled'; expected:string; owner?:string; flag?:string; partial?:boolean }
export type Payment = { id:string; date:string; kind:'Receipt'|'Payment'; party:string; account:string; total:number; wtax:number; net:number; allocations:{ref:string; amount:number}[]; status:'Posted'; createdBy:string }
export type ReportTemplate = { id:string; name:string; description:string; icon:string; category:string; source:string; columns:ColDef[]; savedBy:string; builtIn?:boolean }
export type BankCheque = { id:string; no:string; date:string; bank:string; party:string; amount:number; status:'In hand'|'Presented'|'Cleared'|'Dishonoured' }
export type ChallanLine = { product:string; pack:string; batch:string; expiry:string; qty:number; bonus:number }
export type DeliveryChallan = { id:string; date:string; customer:string; address:string; invoiceRef:string; vehicle?:string; driver?:string; lines:ChallanLine[]; status:'Pending'|'Delivered'|'Cancelled'; preparedBy:string; receivedBy?:string; notes?:string }
export const reportSources = [
 'sales','purchases','stock','movements','ledger','parties','employees','payments','pos',
]

export const voucherTypes = [
 {key:'all',label:'All Vouchers',match:(): boolean=>true},
 {key:'journal',label:'Journal Vouchers',match:(t:string)=>t==='JV'},
 {key:'cash',label:'Cash Vouchers',match:(t:string)=>t==='CRV'||t==='CPV'},
 {key:'bank',label:'Bank Vouchers',match:(t:string)=>t==='BRV'||t==='BPV'},
 {key:'contra',label:'Contra Vouchers',match:(t:string)=>t==='CV'},
 {key:'sales',label:'Sales Invoices',match:(t:string)=>t==='SINV'},
 {key:'purchase',label:'Purchase Invoices (GRN)',match:(t:string)=>t==='PINV'},
 {key:'payments',label:'Payments',match:(t:string)=>t==='CPV'||t==='BPV'},
 {key:'receipts',label:'Receipts',match:(t:string)=>t==='CRV'||t==='BRV'},
]
export const voucherCode:Record<string,string>={'Cash in Hand':'1100-01','Meezan Bank — 8721':'1100-02','HBL — 2294':'1100-03','Accounts Receivable':'1200-01','Inventory':'1300-01','Accounts Payable':'2100-01','Getz Pharma':'2100-02','Sales Revenue':'4100-01','Cost of Goods Sold':'5000-01','Salaries Expense':'5100-01','Rent Expense':'5200-01','Electricity Expense':'5200-02','Sales Commission':'5200-03','Repair & Maintenance':'5200-04','Bank Charges':'5200-05','Advertisement Expense':'5200-06','Opening Stock Adjustment':'1300-01'}

export const seedVouchers: Voucher[] = [
 {id:'JV-2026-0409',date:'30 Aug 2026',type:'JV',narration:'COGS — Augmentin 625mg',reference:'INV-26814',status:'Posted',posting:'Posted',createdBy:'Ahmed Raza',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Cost of Goods Sold',credit:'Inventory',amount:3500,remark:'COGS · Augmentin 625mg'}]},
 {id:'JV-2026-0411',date:'30 Aug 2026',type:'JV',narration:'COGS — Panadol 500mg',reference:'INV-26813',status:'Posted',posting:'Posted',createdBy:'Ahmed Raza',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Cost of Goods Sold',credit:'Inventory',amount:624,remark:'COGS · Panadol 500mg'}]},
 {id:'JV-2026-0412',date:'29 Aug 2026',type:'JV',narration:'Office Rent Payment',reference:'BRV-1024',status:'Draft',posting:'Unposted',createdBy:'Usman Ali',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Rent Expense',credit:'Meezan Bank — 8721',amount:15000,remark:'August office rent'}]},
 {id:'JV-2026-0413',date:'29 Aug 2026',type:'JV',narration:'Staff Salary Payment',reference:'BRV-1025',status:'Posted',posting:'Posted',createdBy:'Usman Ali',branch:'Lahore Main',department:'Payroll',lines:[{debit:'Salaries Expense',credit:'Meezan Bank — 8721',amount:45000,remark:'August salaries — 86 staff'}]},
 {id:'JV-2026-0414',date:'28 Aug 2026',type:'JV',narration:'Electricity Bill Payment',reference:'BRV-1026',status:'Posted',posting:'Posted',createdBy:'Ahmed Raza',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Electricity Expense',credit:'Meezan Bank — 8721',amount:3250,remark:'LESCO — Aug bill'}]},
 {id:'JV-2026-0415',date:'27 Aug 2026',type:'JV',narration:'Sales Commission',reference:'',status:'Draft',posting:'Unposted',createdBy:'Ayesha Noor',branch:'Lahore Main',department:'Sales',lines:[{debit:'Sales Commission',credit:'Accounts Payable',amount:2100,remark:'Field team commission'}]},
 {id:'JV-2026-0416',date:'27 Aug 2026',type:'JV',narration:'Repair & Maintenance',reference:'BRV-1027',status:'Posted',posting:'Posted',createdBy:'Ayesha Noor',branch:'Rawalpindi',department:'Operations',lines:[{debit:'Repair & Maintenance',credit:'HBL — 2294',amount:1850,remark:'Cold-chain unit service'}]},
 {id:'JV-2026-0417',date:'26 Aug 2026',type:'JV',narration:'Bank Charges',reference:'BRV-1028',status:'Posted',posting:'Posted',createdBy:'Usman Ali',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Bank Charges',credit:'Meezan Bank — 8721',amount:480,remark:'Monthly banking charges'}]},
 {id:'JV-2026-0418',date:'26 Aug 2026',type:'JV',narration:'Advertisement Expenses',reference:'BRV-1029',status:'Cancelled',posting:'Unposted',createdBy:'Ahmed Raza',branch:'Lahore Main',department:'Marketing',lines:[{debit:'Advertisement Expense',credit:'Meezan Bank — 8721',amount:2750,remark:'Cancel: duplicate bill'}]},
 {id:'CRV-2026-0102',date:'28 Aug 2026',type:'CRV',narration:'Payment received from Adeel Pharmacy',reference:'INV-26812',status:'Posted',posting:'Posted',createdBy:'Ayesha Noor',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Cash in Hand',credit:'Accounts Receivable',amount:7320,remark:'Settles INV-26812'}]},
 {id:'BRV-2026-0088',date:'29 Aug 2026',type:'BRV',narration:'Cheque banked — Shifa Medical Centre',reference:'CHQ-441290',status:'Posted',posting:'Posted',createdBy:'Hira Ali',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Meezan Bank — 8721',credit:'Accounts Receivable',amount:4160,remark:'Clears INV-26814'}]},
 {id:'BPV-2026-0077',date:'28 Aug 2026',type:'BPV',narration:'Payment to Getz Pharma',reference:'PUR-2026-0184',status:'Posted',posting:'Posted',createdBy:'Hira Ali',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Accounts Payable',credit:'Meezan Bank — 8721',amount:35680,remark:'Settles PUR-2026-0184'}]},
 {id:'CV-2026-0033',date:'27 Aug 2026',type:'CV',narration:'Cash deposited to bank',reference:'',status:'Posted',posting:'Posted',createdBy:'Ayesha Noor',branch:'Lahore Main',department:'Accounts',lines:[{debit:'Meezan Bank — 8721',credit:'Cash in Hand',amount:200000,remark:'Daily cash deposit'}]},
 {id:'CPV-2026-0066',date:'27 Aug 2026',type:'CPV',narration:'Petty cash — office supplies',reference:'PET-011',status:'Posted',posting:'Posted',createdBy:'Usman Ali',branch:'Lahore Main',department:'Operations',lines:[{debit:'Repair & Maintenance',credit:'Cash in Hand',amount:3500,remark:'Stationery & consumables'}]},
 {id:'SINV-26813',date:'30 Aug 2026',type:'SINV',narration:'Retail sale — Panadol 500mg',reference:'INV-26813',status:'Posted',posting:'Posted',createdBy:'Sana Javed',branch:'Lahore Main',department:'Counter',lines:[{debit:'Cash in Hand',credit:'Sales Revenue',amount:720,remark:'Walk-in Customer'}]},
 {id:'PINV-2026-0184',date:'30 Aug 2026',type:'PINV',narration:'GRN — Augmentin 625mg from Getz Pharma',reference:'GRN-2026-0184',status:'Posted',posting:'Posted',createdBy:'Sana Javed',branch:'Lahore Main',department:'Stores',lines:[{debit:'Inventory',credit:'Accounts Payable',amount:35680,remark:'40 packs · AU-610B'}]},
]

export const products: Product[] = [
  {id:'MED-1001',name:'Panadol 500mg',generic:'Paracetamol',category:'Analgesic',batch:'PD-2408',expiry:'2027-08-31',stock:324,reorder:80,cost:312,price:360,supplier:'GlaxoSmithKline',batches:[{id:'PD-2408',expiry:'2027-08-31',stock:124,cost:312},{id:'PD-2502',expiry:'2028-02-28',stock:200,cost:318}]},
  {id:'MED-1002',name:'Augmentin 625mg',generic:'Co-amoxiclav',category:'Antibiotic',batch:'AU-514A',expiry:'2027-02-28',stock:42,reorder:60,cost:892,price:1040,supplier:'Getz Pharma',batches:[{id:'AU-514A',expiry:'2027-02-28',stock:12,cost:875},{id:'AU-610B',expiry:'2027-12-31',stock:30,cost:899}]},
  {id:'MED-1003',name:'Risek 20mg',generic:'Omeprazole',category:'Gastrointestinal',batch:'RK-921',expiry:'2028-01-31',stock:178,reorder:50,cost:525,price:610,supplier:'Martin Dow',batches:[{id:'RK-921',expiry:'2028-01-31',stock:178,cost:525}]},
  {id:'MED-1004',name:'Calpol Suspension',generic:'Paracetamol',category:'Paediatric',batch:'CP-201B',expiry:'2026-12-31',stock:18,reorder:30,cost:164,price:195,supplier:'Sami Pharmaceuticals',batches:[{id:'CP-201B',expiry:'2026-12-31',stock:18,cost:164}]},
  {id:'MED-1005',name:'Lipiget 20mg',generic:'Atorvastatin',category:'Cardiovascular',batch:'LP-881',expiry:'2027-11-30',stock:94,reorder:40,cost:390,price:455,supplier:'High-Q Pharma',batches:[{id:'LP-881',expiry:'2027-11-30',stock:94,cost:390}]},
  {id:'MED-1006',name:'Humulin 70/30',generic:'Human Insulin',category:'Diabetes',batch:'HM-70X',expiry:'2026-10-31',stock:12,reorder:20,cost:1120,price:1285,supplier:'The Searle Company',batches:[{id:'HM-70X',expiry:'2026-10-31',stock:12,cost:1120},{id:'HM-OLD',expiry:'2026-07-31',stock:3,cost:1090}]},
  {id:'MED-1007',name:'Entamizole DS',generic:'Diloxanide + Metronidazole',category:'Anti-infective',batch:'EN-113',expiry:'2027-06-30',stock:205,reorder:45,cost:218,price:260,supplier:'Abbott Laboratories',batches:[{id:'EN-113',expiry:'2027-06-30',stock:205,cost:218}]},
  {id:'MED-1008',name:'Ventolin Inhaler',generic:'Salbutamol',category:'Respiratory',batch:'VN-721',expiry:'2027-03-31',stock:31,reorder:35,cost:635,price:730,supplier:'GlaxoSmithKline',batches:[{id:'VN-721',expiry:'2027-03-31',stock:31,cost:635}]},
]

export const initialPurchases: Purchase[] = [
 {id:'PUR-2026-0184',date:'30 Aug 2026',supplier:'Getz Pharma',product:'Augmentin 625mg',qty:40,amount:35680,status:'Posted',batch:'AU-610B',expiry:'2027-12-31',unitCost:892},
 {id:'PUR-2026-0183',date:'29 Aug 2026',supplier:'GlaxoSmithKline',product:'Panadol 500mg',qty:100,amount:31200,status:'Posted',batch:'PD-2502',expiry:'2028-02-28',unitCost:312},
 {id:'PUR-2026-0182',date:'28 Aug 2026',supplier:'Abbott Laboratories',product:'Entamizole DS',qty:60,amount:13080,status:'Draft',batch:'EN-114',expiry:'2028-03-31',unitCost:218},
 {id:'PUR-2026-0181',date:'27 Aug 2026',supplier:'The Searle Company',product:'Humulin 70/30',qty:24,amount:26880,status:'Posted',batch:'HM-70X',expiry:'2026-10-31',unitCost:1120},
]

export const initialPurchaseReturns: PurchaseReturn[] = [
 {id:'PR-000012',date:'15 Sep 2026',supplier:'Getz Pharma',reference:'PUR-2026-0184',supplierBill:'SB-1124',paymentType:'Cash',status:'Posted',remarks:'Items returned due to expiry damage during delivery.',amount:4450,lines:[{product:'Augmentin 625mg',pack:"10's",batch:'AU-610B',expiry:'2027-12-31',rate:890,qty:5,bonus:0,discount:0,gst:0}]},
 {id:'PR-000011',date:'14 Sep 2026',supplier:'GlaxoSmithKline',reference:'PUR-2026-0183',supplierBill:'SB-1108',paymentType:'Credit',status:'Draft',remarks:'Awaiting supplier confirmation.',amount:1560,lines:[{product:'Panadol 500mg',pack:"10's",batch:'PD-2502',expiry:'2028-02-28',rate:312,qty:5,bonus:0,discount:0,gst:0}]},
 {id:'PR-000010',date:'12 Sep 2026',supplier:'Abbott Laboratories',reference:'PUR-2026-0182',supplierBill:'SB-1090',paymentType:'Cash',status:'Referenced',remarks:'Referenced to supplier debit note.',amount:654,lines:[{product:'Entamizole DS',pack:"10's",batch:'EN-113',expiry:'2027-06-30',rate:218,qty:3,bonus:0,discount:0,gst:0}]},
 {id:'PR-000009',date:'10 Sep 2026',supplier:'The Searle Company',reference:'PUR-2026-0181',supplierBill:'SB-1084',paymentType:'Credit',status:'Posted',remarks:'Cold-chain temperature exception.',amount:2240,lines:[{product:'Humulin 70/30',pack:'Vial',batch:'HM-70X',expiry:'2026-10-31',rate:1120,qty:2,bonus:0,discount:0,gst:0}]},
 {id:'PR-000008',date:'08 Sep 2026',supplier:'High-Q Pharma',reference:'—',supplierBill:'SB-1076',paymentType:'Cash',status:'Cancelled',remarks:'Cancelled before dispatch.',amount:390,lines:[{product:'Lipiget 20mg',pack:"10's",batch:'LP-881',expiry:'2027-11-30',rate:390,qty:1,bonus:0,discount:0,gst:0}]},
]

export const initialSales: Sale[] = [
 {id:'INV-26814',date:'30 Aug 2026',customer:'Shifa Medical Centre',product:'Augmentin 625mg',qty:4,amount:4160,mode:'Wholesale',status:'Credit',batch:'AU-514A',unitCost:875},
 {id:'INV-26813',date:'30 Aug 2026',customer:'Walk-in Customer',product:'Panadol 500mg',qty:2,amount:720,mode:'Retail',status:'Paid',batch:'PD-2408',unitCost:312},
 {id:'INV-26812',date:'29 Aug 2026',customer:'Adeel Pharmacy',product:'Risek 20mg',qty:12,amount:7320,mode:'Wholesale',status:'Credit',batch:'RK-921',unitCost:525},
 {id:'INV-26811',date:'29 Aug 2026',customer:'Walk-in Customer',product:'Ventolin Inhaler',qty:1,amount:730,mode:'Retail',status:'Paid',batch:'VN-721',unitCost:635},
]

export const initialMovements: StockMovement[] = [
 {id:'MOV-3001',date:'30 Aug 2026',product:'Augmentin 625mg',batch:'AU-514A',type:'Sale',qty:-4,reference:'INV-26814',from:'Lahore Main',unitCost:892,note:'Retail sale — FEFO batch'},
 {id:'MOV-3002',date:'30 Aug 2026',product:'Panadol 500mg',batch:'PD-2408',type:'Sale',qty:-2,reference:'INV-26813',from:'Lahore Main',unitCost:312,note:'Counter sale'},
 {id:'MOV-3003',date:'30 Aug 2026',product:'Augmentin 625mg',batch:'AU-610B',type:'Purchase',qty:40,reference:'PUR-2026-0184',to:'Lahore Main',unitCost:892,note:'Supplier receipt — Getz Pharma'},
 {id:'MOV-3004',date:'29 Aug 2026',product:'Panadol 500mg',batch:'PD-2502',type:'Purchase',qty:100,reference:'PUR-2026-0183',to:'Lahore Main',unitCost:312,note:'Supplier receipt — GSK'},
 {id:'MOV-3005',date:'27 Aug 2026',product:'Humulin 70/30',batch:'HM-70X',type:'Purchase',qty:24,reference:'PUR-2026-0181',to:'Karachi Warehouse',unitCost:1450,note:'Cold-chain receipt'},
 {id:'MOV-3006',date:'29 Aug 2026',product:'Ventolin Inhaler',batch:'VN-721',type:'Gift',qty:2,reference:'GFT-0031',to:'Lahore Main',unitCost:640,note:'Free goods from supplier'},
 {id:'MOV-3007',date:'29 Aug 2026',product:'Panadol 500mg',batch:'PD-2408',type:'Breakage',qty:-1,reference:'BRK-0042',from:'Lahore Main',unitCost:312,note:'Damaged in handling'},
 {id:'MOV-3009',date:'29 Aug 2026',product:'Risek 20mg',batch:'RK-921',type:'Transfer',qty:24,reference:'TRF-0081',from:'Lahore Main',to:'Rawalpindi',unitCost:520,note:'Branch replenishment — received'},
 {id:'MOV-3008',date:'29 Aug 2026',product:'Risek 20mg',batch:'RK-921',type:'Transfer',qty:-24,reference:'TRF-0081',from:'Lahore Main',to:'Rawalpindi',unitCost:520,note:'Branch replenishment'},
]

export const initialJournals: Journal[] = [
 // ---- Opening balances · 01 Aug 2026 (from the legacy books) ----
 {id:'JV-2026-0501',date:'01 Aug 2026',description:'Opening balance — Cash in Hand',debit:'Cash in Hand',credit:'Reserves & Surplus',amount:850000,reference:'OB-2026'},
 {id:'JV-2026-0502',date:'01 Aug 2026',description:'Opening balance — Meezan Bank 8721',debit:'Meezan Bank — 8721',credit:'Reserves & Surplus',amount:1700000,reference:'OB-2026'},
 {id:'JV-2026-0503',date:'01 Aug 2026',description:'Opening balance — HBL 2294',debit:'HBL — 2294',credit:'Reserves & Surplus',amount:950000,reference:'OB-2026'},
 {id:'JV-2026-0504',date:'01 Aug 2026',description:'Opening balance — Accounts Receivable',debit:'Accounts Receivable',credit:'Reserves & Surplus',amount:1140000,reference:'OB-2026'},
 {id:'JV-2026-0505',date:'01 Aug 2026',description:'Opening balance — Inventory',debit:'Inventory',credit:'Reserves & Surplus',amount:1980000,reference:'OB-2026'},
 {id:'JV-2026-0506',date:'01 Aug 2026',description:'Opening balance — Accounts Payable',debit:'Reserves & Surplus',credit:'Accounts Payable',amount:520000,reference:'OB-2026'},
 // ---- Cash / retail sales (weekly totals) ----
 {id:'JV-2026-0510',date:'03 Aug 2026',description:'Cash sales — week 1',debit:'Cash in Hand',credit:'Sales Revenue',amount:368000,reference:'CS-W1'},
 {id:'JV-2026-0511',date:'10 Aug 2026',description:'Cash sales — week 2',debit:'Cash in Hand',credit:'Sales Revenue',amount:360000,reference:'CS-W2'},
 {id:'JV-2026-0512',date:'17 Aug 2026',description:'Cash sales — week 3',debit:'Cash in Hand',credit:'Sales Revenue',amount:362000,reference:'CS-W3'},
 {id:'JV-2026-0513',date:'24 Aug 2026',description:'Cash sales — week 4',debit:'Cash in Hand',credit:'Sales Revenue',amount:368000,reference:'CS-W4'},
 {id:'JV-2026-0514',date:'30 Aug 2026',description:'Cash sales — week 5',debit:'Cash in Hand',credit:'Sales Revenue',amount:350000,reference:'CS-W5'},
 // ---- Wholesale / credit sales ----
 {id:'JV-2026-0515',date:'05 Aug 2026',description:'Credit sales — Shifa, Adeel & clinics',debit:'Accounts Receivable',credit:'Sales Revenue',amount:300000,reference:'WS-W1'},
 {id:'JV-2026-0516',date:'12 Aug 2026',description:'Credit sales — institutional',debit:'Accounts Receivable',credit:'Sales Revenue',amount:280000,reference:'WS-W2'},
 {id:'JV-2026-0517',date:'19 Aug 2026',description:'Credit sales — wholesale',debit:'Accounts Receivable',credit:'Sales Revenue',amount:300000,reference:'WS-W3'},
 {id:'JV-2026-0518',date:'26 Aug 2026',description:'Credit sales — wholesale',debit:'Accounts Receivable',credit:'Sales Revenue',amount:300000,reference:'WS-W4'},
 {id:'JV-2026-0519',date:'29 Aug 2026',description:'Credit sales — hospital tender',debit:'Accounts Receivable',credit:'Sales Revenue',amount:220000,reference:'WS-W5'},
 // ---- Cost of goods sold (cash sales) ----
 {id:'JV-2026-0520',date:'03 Aug 2026',description:'COGS — cash sales week 1',debit:'Cost of Goods Sold',credit:'Inventory',amount:261000,reference:'COGS-W1'},
 {id:'JV-2026-0521',date:'10 Aug 2026',description:'COGS — cash sales week 2',debit:'Cost of Goods Sold',credit:'Inventory',amount:256000,reference:'COGS-W2'},
 {id:'JV-2026-0522',date:'17 Aug 2026',description:'COGS — cash sales week 3',debit:'Cost of Goods Sold',credit:'Inventory',amount:257000,reference:'COGS-W3'},
 {id:'JV-2026-0523',date:'24 Aug 2026',description:'COGS — cash sales week 4',debit:'Cost of Goods Sold',credit:'Inventory',amount:261000,reference:'COGS-W4'},
 {id:'JV-2026-0524',date:'30 Aug 2026',description:'COGS — cash sales week 5',debit:'Cost of Goods Sold',credit:'Inventory',amount:248000,reference:'COGS-W5'},
 // ---- Cost of goods sold (credit sales) ----
 {id:'JV-2026-0525',date:'05 Aug 2026',description:'COGS — credit sales week 1',debit:'Cost of Goods Sold',credit:'Inventory',amount:213000,reference:'COGS-CW1'},
 {id:'JV-2026-0526',date:'12 Aug 2026',description:'COGS — credit sales week 2',debit:'Cost of Goods Sold',credit:'Inventory',amount:199000,reference:'COGS-CW2'},
 {id:'JV-2026-0527',date:'19 Aug 2026',description:'COGS — credit sales week 3',debit:'Cost of Goods Sold',credit:'Inventory',amount:213000,reference:'COGS-CW3'},
 {id:'JV-2026-0528',date:'26 Aug 2026',description:'COGS — credit sales week 4',debit:'Cost of Goods Sold',credit:'Inventory',amount:213000,reference:'COGS-CW4'},
 {id:'JV-2026-0529',date:'29 Aug 2026',description:'COGS — credit sales week 5',debit:'Cost of Goods Sold',credit:'Inventory',amount:156000,reference:'COGS-CW5'},
 // ---- Purchases (GRN → inventory) ----
 {id:'JV-2026-0530',date:'05 Aug 2026',description:'Inventory purchase · Getz Pharma',debit:'Inventory',credit:'Accounts Payable',amount:380000,reference:'PUR-2026-0185'},
 {id:'JV-2026-0531',date:'08 Aug 2026',description:'Inventory purchase · GlaxoSmithKline',debit:'Inventory',credit:'Accounts Payable',amount:350000,reference:'PUR-2026-0186'},
 {id:'JV-2026-0532',date:'12 Aug 2026',description:'Inventory purchase · The Searle Company',debit:'Inventory',credit:'Accounts Payable',amount:420000,reference:'PUR-2026-0187'},
 {id:'JV-2026-0533',date:'16 Aug 2026',description:'Inventory purchase · Abbott Laboratories',debit:'Inventory',credit:'Accounts Payable',amount:360000,reference:'PUR-2026-0188'},
 {id:'JV-2026-0534',date:'19 Aug 2026',description:'Inventory purchase · Getz Pharma',debit:'Inventory',credit:'Accounts Payable',amount:460000,reference:'PUR-2026-0189'},
 {id:'JV-2026-0535',date:'22 Aug 2026',description:'Inventory purchase · High-Q Pharma',debit:'Inventory',credit:'Accounts Payable',amount:380000,reference:'PUR-2026-0190'},
 {id:'JV-2026-0536',date:'26 Aug 2026',description:'Inventory purchase · Sami Pharmaceuticals',debit:'Inventory',credit:'Accounts Payable',amount:410000,reference:'PUR-2026-0191'},
 {id:'JV-2026-0537',date:'29 Aug 2026',description:'Inventory purchase · GlaxoSmithKline',debit:'Inventory',credit:'Accounts Payable',amount:340000,reference:'PUR-2026-0192'},
 // ---- Receipts / collections from customers ----
 {id:'JV-2026-0538',date:'06 Aug 2026',description:'Receipt — Adeel Pharmacy',debit:'Cash in Hand',credit:'Accounts Receivable',amount:400000,reference:'CRV-2026-0103'},
 {id:'JV-2026-0539',date:'11 Aug 2026',description:'Cheque banked — Shifa Medical Centre',debit:'Meezan Bank — 8721',credit:'Accounts Receivable',amount:350000,reference:'BRV-2026-0089'},
 {id:'JV-2026-0540',date:'18 Aug 2026',description:'Receipt — walk-in wholesale',debit:'Cash in Hand',credit:'Accounts Receivable',amount:400000,reference:'CRV-2026-0104'},
 {id:'JV-2026-0541',date:'22 Aug 2026',description:'Cheque banked — Adeel Pharmacy',debit:'Meezan Bank — 8721',credit:'Accounts Receivable',amount:350000,reference:'BRV-2026-0090'},
 {id:'JV-2026-0542',date:'26 Aug 2026',description:'Cheque banked — Shifa Medical Centre',debit:'HBL — 2294',credit:'Accounts Receivable',amount:340000,reference:'BRV-2026-0091'},
 // ---- Supplier payments ----
 {id:'JV-2026-0543',date:'09 Aug 2026',description:'Payment — Getz Pharma',debit:'Accounts Payable',credit:'Meezan Bank — 8721',amount:1300000,reference:'BPV-2026-0078'},
 {id:'JV-2026-0544',date:'20 Aug 2026',description:'Payment — GlaxoSmithKline',debit:'Accounts Payable',credit:'Meezan Bank — 8721',amount:1000000,reference:'BPV-2026-0079'},
 {id:'JV-2026-0545',date:'28 Aug 2026',description:'Payment — The Searle Company',debit:'Accounts Payable',credit:'HBL — 2294',amount:720000,reference:'BPV-2026-0080'},
 // ---- Operating expenses ----
 {id:'JV-2026-0546',date:'05 Aug 2026',description:'August office rent',debit:'Rent Expense',credit:'Meezan Bank — 8721',amount:60000,reference:'BRV-1024'},
 {id:'JV-2026-0547',date:'12 Aug 2026',description:'Electricity — LESCO bill',debit:'Electricity Expense',credit:'Meezan Bank — 8721',amount:42000,reference:'BRV-1026'},
 {id:'JV-2026-0548',date:'19 Aug 2026',description:'Cold-chain unit service',debit:'Repair & Maintenance',credit:'Meezan Bank — 8721',amount:18000,reference:'BRV-1027'},
 {id:'JV-2026-0549',date:'20 Aug 2026',description:'Store campaign — leaflet & press',debit:'Advertisement Expense',credit:'Meezan Bank — 8721',amount:25000,reference:'BRV-1029'},
 {id:'JV-2026-0550',date:'25 Aug 2026',description:'Field team sales commission',debit:'Sales Commission',credit:'Accounts Payable',amount:60000,reference:'COM-AUG'},
 {id:'JV-2026-0551',date:'29 Aug 2026',description:'Monthly banking charges',debit:'Bank Charges',credit:'Meezan Bank — 8721',amount:7200,reference:'BRV-1028'},
 {id:'JV-2026-0552',date:'30 Aug 2026',description:'August salaries — all staff',debit:'Salaries Expense',credit:'Meezan Bank — 8721',amount:420000,reference:'BRV-1025'},
 // ---- Cash deposited to bank (contra) ----
 {id:'JV-2026-0553',date:'24 Aug 2026',description:'Daily cash deposited to Meezan',debit:'Meezan Bank — 8721',credit:'Cash in Hand',amount:800000,reference:'CV-2026-0034'},
 {id:'JV-2026-0554',date:'27 Aug 2026',description:'Daily cash deposited to HBL',debit:'HBL — 2294',credit:'Cash in Hand',amount:400000,reference:'CV-2026-0035'},
 // ---- Demo invoices shown on the Sales & Receivables screens ----
 {id:'JV-2026-0555',date:'30 Aug 2026',description:'Sale · Shifa Medical Centre',debit:'Accounts Receivable',credit:'Sales Revenue',amount:4160,reference:'INV-26814'},
 {id:'JV-2026-0556',date:'30 Aug 2026',description:'COGS · Augmentin 625mg',debit:'Cost of Goods Sold',credit:'Inventory',amount:3500,reference:'INV-26814'},
 {id:'JV-2026-0557',date:'30 Aug 2026',description:'Sale · Walk-in Customer',debit:'Cash in Hand',credit:'Sales Revenue',amount:720,reference:'INV-26813'},
 {id:'JV-2026-0558',date:'30 Aug 2026',description:'COGS · Panadol 500mg',debit:'Cost of Goods Sold',credit:'Inventory',amount:624,reference:'INV-26813'},
 {id:'JV-2026-0559',date:'29 Aug 2026',description:'Sale · Adeel Pharmacy',debit:'Accounts Receivable',credit:'Sales Revenue',amount:7320,reference:'INV-26812'},
 {id:'JV-2026-0560',date:'29 Aug 2026',description:'COGS · Risek 20mg',debit:'Cost of Goods Sold',credit:'Inventory',amount:6300,reference:'INV-26812'},
 {id:'JV-2026-0561',date:'29 Aug 2026',description:'Sale · Walk-in Customer',debit:'Cash in Hand',credit:'Sales Revenue',amount:730,reference:'INV-26811'},
 {id:'JV-2026-0562',date:'29 Aug 2026',description:'COGS · Ventolin Inhaler',debit:'Cost of Goods Sold',credit:'Inventory',amount:635,reference:'INV-26811'},
]

export const chartData = [
 {day:'Mon',sales:128000,purchases:72000},{day:'Tue',sales:154000,purchases:96000},{day:'Wed',sales:142000,purchases:68000},
 {day:'Thu',sales:181000,purchases:112000},{day:'Fri',sales:164000,purchases:84000},{day:'Sat',sales:218000,purchases:121000},{day:'Sun',sales:192000,purchases:91000},
]

export type NavChild={label:string;path?:string;icon?:string;perm?:string;children?:NavChild[]}
export type NavItem={label:string;icon?:string;path?:string;perm?:string;caption?:string;desc?:string;children?:NavChild[]}
export type NavGroup={group:string;tagline?:string;icon?:string;items:NavItem[]}
export const nav:NavGroup[] = [
 {group:'',items:[
  {label:'Dashboard',desc:'Overview & insights',path:'/dashboard',icon:'LayoutDashboard',perm:'Dashboard'},
  {label:'Today',desc:'Tasks & activities',path:'/today',icon:'CalendarCheck',perm:'Cash, Bank & GL'},
 ]},
 {group:'Finance',tagline:'Manage your finances',icon:'Coins',items:[
  {label:'Accounts',desc:'Chart of accounts and ledgers',icon:'Landmark',perm:'Cash, Bank & GL',children:[{label:'Chart of Accounts',path:'/accounts',icon:'Landmark',perm:'Cash, Bank & GL'},{label:'Account Ledger',path:'/ledgers',icon:'BookOpen',perm:'Cash, Bank & GL'},{label:'Cash Book',path:'/cash-book',icon:'Banknote',perm:'Cash, Bank & GL'}]},
  {label:'Voucher Management',desc:'Create and manage vouchers',icon:'ReceiptText',perm:'Cash, Bank & GL',children:[{label:'Voucher Register',path:'/vouchers',icon:'ReceiptText',perm:'Cash, Bank & GL'},{label:'New Voucher',path:'/vouchers/new',icon:'FilePlus2',perm:'Cash, Bank & GL'},{label:'Voucher Templates',path:'/recurring',icon:'ClipboardList',perm:'Cash, Bank & GL'}]},
  {label:'Bank',desc:'Banking and cheque operations',icon:'Landmark',perm:'Cash, Bank & GL',children:[{label:'Bank Accounts',path:'/bank-accounts',icon:'Landmark',perm:'Cash, Bank & GL'},{label:'Bank Transactions',path:'/bank-transactions',icon:'Banknote',perm:'Cash, Bank & GL'},{label:'Receive & Issue Cheques',path:'/cheque-voucher',icon:'ArrowDownRight',perm:'Cash, Bank & GL'},{label:'CH. Posting & Reversal',path:'/cheque-posting',icon:'ClipboardCheck',perm:'Cash, Bank & GL'},{label:'Cheque Exceptions',path:'/cheque-actions',icon:'ShieldAlert',perm:'Cash, Bank & GL'},{label:'Bank Book',path:'/bank-book',icon:'WalletCards',perm:'Cash, Bank & GL'}]},
  {label:'Cash Transactions',desc:'Manage cash entries',path:'/cash-transactions',icon:'Banknote',perm:'Cash, Bank & GL'},
  {label:'Financial Statements',desc:'Reports and statements',path:'/reports',icon:'FileChartColumn',perm:'Cash, Bank & GL'},
 ]},
 {group:'Sales & Distribution',tagline:'Grow your business',icon:'ShoppingCart',items:[
  {label:'Sales',desc:'Orders, invoicing and delivery',icon:'ShoppingCart',perm:'Sales & POS',children:[{label:'Sales Invoices',path:'/sales',icon:'ReceiptText',perm:'Sales & POS'},{label:'Orders / Demand',path:'/procurement',icon:'ClipboardList',perm:'Demand & PO'},{label:'Delivery Challans',path:'/delivery-challans',icon:'Truck',perm:'Sales & POS'},{label:'Quotations',path:'/sales',icon:'FileText',perm:'Sales & POS'},{label:'Sales Returns',path:'/sales-returns',icon:'History',perm:'Sales & POS'},{label:'Sales Register',path:'/reports/sales-register',icon:'ChartNoAxesCombined',perm:'Reports'}]},
  {label:'Sales Voucher',path:'/sales/voucher',icon:'FileText',perm:'Sales & POS'},
  {label:'Distribution',desc:'Loads, runs and recovery',icon:'ArrowLeftRight',perm:'Sales & POS',children:[{label:'Open Demands',path:'/procurement',icon:'FolderTree',perm:'Demand & PO'},{label:'Load Sheets',path:'/field-sales',icon:'ClipboardCheck',perm:'Sales & POS'},{label:'Delivery Runs',path:'/field-sales',icon:'Truck',perm:'Sales & POS'},{label:'Run Settlement',path:'/field-sales',icon:'HandCoins',perm:'Sales & POS'},{label:'Field Recovery',path:'/field-sales',icon:'MapPin',perm:'Sales & POS'}]},
  {label:'Sales Force',desc:'Team, routes and targets',icon:'ContactRound',perm:'Sales & POS',children:[{label:'Sales Team',path:'/hr',icon:'UserCog',perm:'HR & Payroll'},{label:'Routes & Territories',path:'/field-sales',icon:'MapPin',perm:'Sales & POS'},{label:'Targets',path:'/field-sales',icon:'Target',perm:'Sales & POS'},{label:'Performance',path:'/field-sales',icon:'TrendingUp',perm:'Sales & POS'}]},
 ]},
 {group:'Purchase & Stock',tagline:'Buy and stock smart',icon:'Warehouse',items:[
  {label:'Purchases',desc:'Orders, receipts and bills',icon:'ShoppingBag',perm:'Purchasing',children:[{label:'Purchase Orders',path:'/po',icon:'ClipboardPlus',perm:'Demand & PO'},{label:'Purchase Voucher',path:'/purchasing/voucher',icon:'ReceiptText',perm:'Purchasing'},{label:'Goods Receipts (GRN)',path:'/purchasing',icon:'PackageCheck',perm:'Purchasing'},{label:'Purchase Invoices',path:'/purchasing',icon:'FileText',perm:'Purchasing'},{label:'Purchase Returns',path:'/purchasing/returns',icon:'History',perm:'Purchasing'},{label:'Purchase Register',path:'/purchasing',icon:'ClipboardList',perm:'Purchasing'},{label:'Print Documents',path:'/purchasing/print',icon:'Printer',perm:'Purchasing'}]},
  {label:'Inventory',desc:'Stock, movements and counts',icon:'Boxes',perm:'Inventory',children:[{label:'Stock',path:'/inventory',icon:'Layers',perm:'Inventory'},{label:'Stock Movements',path:'/inventory/movements/history',icon:'History',perm:'Inventory'},{label:'Stock Entry',path:'/inventory/stock-in',icon:'FilePlus2',perm:'Inventory'},{label:'Transfers',path:'/inventory/transfer',icon:'ArrowLeftRight',perm:'Inventory'},{label:'Stock Counts',path:'/inventory/count',icon:'ClipboardCheck',perm:'Inventory'},{label:'Breakage & Adjustments',path:'/inventory/breakage',icon:'ShieldAlert',perm:'Inventory'},{label:'Inventory Reports',path:'/inventory-reports',icon:'FileChartColumn',perm:'Reports'}]},
  {label:'Products',desc:'Catalogue and classification',icon:'Pill',perm:'Products',children:[{label:'Companies',path:'/companies',icon:'Building2',perm:'Products'},{label:'Classification',path:'/product-classes',icon:'Layers',perm:'Products'},{label:'Product Catalogue',path:'/products',icon:'Pill',perm:'Products'},{label:'Reports',path:'/product-reports',icon:'FileChartColumn',perm:'Reports'},]},
 ]},
 {group:'Parties',tagline:'Customers and vendors',icon:'UsersRound',items:[
  {label:'Customers',desc:'Customer accounts',path:'/customers',icon:'Users',perm:'Masters'},
  {label:'Vendors',desc:'Supplier accounts',path:'/vendors',icon:'ContactRound',perm:'Masters'},
 ]},
 {group:'Financial Operations',tagline:'Money in and out',icon:'ArrowLeftRight',items:[
  {label:'Receivables',desc:"Collect what you're owed",icon:'ArrowDownRight',perm:'Cash, Bank & GL',children:[{label:'Receivables Overview',path:'/receivables',icon:'ArrowDownRight',perm:'Cash, Bank & GL'},{label:'Receipt Management',path:'/payments',icon:'WalletCards',perm:'Cash, Bank & GL'},{label:'Receipt Allocation',path:'/payments',icon:'Wallet',perm:'Cash, Bank & GL'},{label:'Ageing & Due',path:'/receivables',icon:'CalendarDays',perm:'Cash, Bank & GL'},{label:'Recovery',path:'/receivables',icon:'HandCoins',perm:'Cash, Bank & GL'},{label:'Credit Control',path:'/credit-limits',icon:'ShieldCheck',perm:'Cash, Bank & GL'}]},
  {label:'Payables',desc:'Pay what you owe',icon:'ArrowUpRight',perm:'Cash, Bank & GL',children:[{label:'Payables Overview',path:'/payables',icon:'ArrowUpRight',perm:'Cash, Bank & GL'},{label:'Payment Management',path:'/payments',icon:'WalletCards',perm:'Cash, Bank & GL'},{label:'Payment Allocation',path:'/payments',icon:'Wallet',perm:'Cash, Bank & GL'},{label:'Ageing & Due',path:'/payables',icon:'CalendarDays',perm:'Cash, Bank & GL'},{label:'Cheques / PDCs',path:'/cheque-clearing',icon:'ScrollText',perm:'Cash, Bank & GL'},{label:'Tax & Advances',path:'/payables',icon:'Percent',perm:'Cash, Bank & GL'}]},
 ]},
 {group:'Workforce',tagline:'Your people',icon:'Users',items:[
  {label:'Employees & Payroll',desc:'Staff, attendance and pay',icon:'Users',perm:'HR & Payroll',children:[{label:'Employees',path:'/hr',icon:'Users',perm:'HR & Payroll'},{label:'Attendance',path:'/hr/attendance',icon:'CalendarDays',perm:'HR & Payroll'},{label:'Payroll',path:'/hr/payroll',icon:'Wallet',perm:'HR & Payroll'},{label:'Employee Advances',path:'/hr',icon:'HandCoins',perm:'HR & Payroll'}]},
 ]},
 {group:'Insights',tagline:'See the bigger picture',icon:'ChartPie',items:[
  {label:'Reports & Analytics',desc:'Reports, dashboards and exports',icon:'FileChartColumn',path:'/reports/analytics',perm:'Reports'},
 ]},
 {group:'System',tagline:'Configure Finsoft',icon:'Settings2',items:[
  {label:'Settings',desc:'Company and system setup',icon:'Settings2',perm:'Admin & Control',children:[{label:'Company',path:'/settings',icon:'Building2',perm:'Admin & Control'},{label:'Finance',path:'/settings',icon:'Landmark',perm:'Admin & Control'},{label:'Sales & Distribution',path:'/settings',icon:'ShoppingCart',perm:'Admin & Control'},{label:'Purchase',path:'/settings',icon:'ShoppingBag',perm:'Admin & Control'},{label:'Inventory & Products',path:'/settings',icon:'Boxes',perm:'Admin & Control'},{label:'Tax',path:'/settings',icon:'Percent',perm:'Admin & Control'},{label:'Users & Roles',path:'/admin',icon:'Users',perm:'Admin & Control'},{label:'Approval Rules',path:'/approvals',icon:'ShieldCheck',perm:'Cash, Bank & GL'},{label:'Print Templates',path:'/reports/templates',icon:'FileText',perm:'Reports'},{label:'Audit Trail',path:'/admin-audit',icon:'ScrollText',perm:'Admin & Control'},{label:'Backup & Restore',path:'/settings',icon:'Database',perm:'Admin & Control'}]},
 ]},
]
export const masters: Master[] = [
 // ---- Level 1 primary ----
 {code:'1000',name:'Assets',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:1,parent:null},
 {code:'2000',name:'Liabilities',type:'Liability',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:1,parent:null},
 {code:'3000',name:'Equity',type:'Equity',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:1,parent:null},
 {code:'4000',name:'Income',type:'Revenue',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:1,parent:null},
 {code:'5000',name:'Expenses',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:1,parent:null},
 // ---- Level 2 subtypes ----
 {code:'1100',name:'Current Assets',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'1000'},
 {code:'1200',name:'Receivables',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'1000'},
 {code:'1300',name:'Inventory',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'1000'},
 {code:'1400',name:'Non-current Assets',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'1000'},
 {code:'2100',name:'Trade Payables',type:'Liability',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'2000'},
 {code:'2200',name:'Other Liabilities',type:'Liability',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'2000'},
 {code:'3100',name:'Reserves & Surplus',type:'Equity',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'3000'},
 {code:'4100',name:'Sales & Service Income',type:'Revenue',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'4000'},
 {code:'4200',name:'Other Income',type:'Revenue',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'4000'},
 {code:'5100',name:'Cost of Goods Sold',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'5000'},
 {code:'5200',name:'Operating & Admin Expenses',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:2,parent:'5000'},
 // ---- Level 3 groups ----
 {code:'1110',name:'Cash Accounts',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'1100'},
 {code:'1120',name:'Bank Accounts',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'1100'},
 {code:'1210',name:'Trade Receivables',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'1200'},
 {code:'1310',name:'Stock in Trade',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'1300'},
 {code:'2110',name:'Supplier Accounts',type:'Liability',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'2100'},
 {code:'4110',name:'Product Sales',type:'Revenue',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'4100'},
 {code:'5110',name:'Cost of Sales',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'5100'},
 {code:'5210',name:'People & Occupancy',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'5200'},
 {code:'5220',name:'Utilities & Operations',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'5200'},
 {code:'5230',name:'Marketing & Sales Costs',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:3,parent:'5200'},
 // ---- Level 4 transaction accounts (postable) ----
 {code:'1110-01',name:'Cash in Hand',type:'Asset',balanceType:'Debit',status:'Active',city:'Lahore',contact:'—',balance:684320,level:4,parent:'1110'},
 {code:'1120-01',name:'Meezan Bank — 8721',type:'Bank',balanceType:'Debit',status:'Active',city:'Lahore',contact:'MEEZ-8721',balance:2140580,level:4,parent:'1120'},
 {code:'1120-02',name:'HBL — 2294',type:'Bank',balanceType:'Debit',status:'Active',city:'Lahore',contact:'HBL-2294',balance:1018640,level:4,parent:'1120'},
 {code:'1210-01',name:'Accounts Receivable',type:'Asset',balanceType:'Debit',status:'Active',city:'Lahore',contact:'—',balance:1280040,level:4,parent:'1210'},
 {code:'1310-01',name:'Inventory',type:'Asset',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'1310'},
 {code:'2110-01',name:'Accounts Payable',type:'Liability',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'2110'},
 {code:'4110-01',name:'Sales Revenue',type:'Revenue',balanceType:'Credit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'4110'},
 {code:'5110-01',name:'Cost of Goods Sold',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'5110'},
 {code:'5210-01',name:'Salaries Expense',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'5210'},
 {code:'5210-02',name:'Rent Expense',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'5210'},
 {code:'5220-01',name:'Electricity Expense',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'5220'},
 {code:'5220-02',name:'Repair & Maintenance',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'5220'},
 {code:'5220-03',name:'Bank Charges',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'5220'},
 {code:'5230-01',name:'Sales Commission',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'5230'},
 {code:'5230-02',name:'Advertisement Expense',type:'Expense',balanceType:'Debit',status:'Active',city:'—',contact:'—',balance:0,level:4,parent:'5230'},
 // ---- Parties, banks & masters used outside the chart (no level) ----
 {code:'CUS-2201',name:'Shifa Medical Centre',type:'Customer',balanceType:'Debit',status:'Active',city:'Lahore',contact:'042-3578-2210',balance:4160,extra:{partyType:'Customer',dealing:'Dr. Sana Iqbal',area:'Gulberg',ntn:'1234567-8',email:'accounts@shifamedical.pk',creditDays:'30'}},
 {code:'CUS-2202',name:'Adeel Pharmacy',type:'Customer',balanceType:'Debit',status:'Active',city:'Lahore',contact:'042-3571-8840',balance:7320,extra:{partyType:'Shop',dealing:'Adeel Ahmed',area:'Johar Town',ntn:'2345678-1',email:'adeel@pharmacy.pk',creditDays:'15'}},
 {code:'CUS-2203',name:'Ahmed Traders',type:'Customer',balanceType:'Debit',status:'Active',city:'Lahore',contact:'0300-1234567',balance:18200,extra:{partyType:'Shop',dealing:'Ali Raza',area:'Shadman',ntn:'3456789-2',email:'ali@ahmedtraders.pk',creditDays:'30'}},
 {code:'CUS-2204',name:'Khan General Store',type:'Customer',balanceType:'Debit',status:'Active',city:'Karachi',contact:'0301-2345678',balance:0,extra:{partyType:'Shop',dealing:'Imran Khan',area:'Clifton',ntn:'4567890-3',email:'imran@khanstore.pk',creditDays:'15'}},
 {code:'CUS-2205',name:'Saeed & Sons',type:'Customer',balanceType:'Debit',status:'Active',city:'Faisalabad',contact:'0302-3456789',balance:12650,extra:{partyType:'Customer',dealing:'Saeed Akhtar',area:'D Ground',ntn:'5678901-4',email:'saeed@saeedsons.pk',creditDays:'30'}},
 {code:'CUS-2206',name:'City Super Mart',type:'Customer',balanceType:'Debit',status:'Active',city:'Islamabad',contact:'0303-4567890',balance:48900,extra:{partyType:'Shop',dealing:'Hassan Rauf',area:'Blue Area',ntn:'6789012-5',email:'accounts@citysupermart.pk',creditDays:'45'}},
 {code:'CUS-2207',name:'Bilal Traders',type:'Customer',balanceType:'Debit',status:'Inactive',city:'Lahore',contact:'0304-5678901',balance:0,extra:{partyType:'Shop',dealing:'Bilal Ahmed',area:'Model Town',ntn:'7890123-6',email:'bilal@traders.pk',creditDays:'15'}},
 {code:'CUS-2208',name:'Al-Noor Store',type:'Customer',balanceType:'Debit',status:'Active',city:'Multan',contact:'0305-6789012',balance:9400,extra:{partyType:'Shop',dealing:'Noor Hassan',area:'Cantt',ntn:'8901234-7',email:'noor@alnoorstore.pk',creditDays:'30'}},
 {code:'CUS-2209',name:'Zara Mart',type:'Customer',balanceType:'Debit',status:'Active',city:'Rawalpindi',contact:'0306-7890123',balance:5400,extra:{partyType:'Shop',dealing:'Zara Malik',area:'Saddar',ntn:'9012345-8',email:'zara@zaramart.pk',creditDays:'15'}},
 {code:'CUS-2210',name:'Rehman Stores',type:'Customer',balanceType:'Debit',status:'Active',city:'Peshawar',contact:'0307-8901234',balance:21600,extra:{partyType:'Customer',dealing:'Abdul Rehman',area:'University Road',ntn:'0123456-9',email:'rehman@stores.pk',creditDays:'30'}},
 {code:'SUP-1004',name:'Getz Pharma',type:'Supplier',balanceType:'Credit',status:'Active',city:'Karachi',contact:'021-111-266-266',balance:184500,extra:{partyType:'Manufacturer',dealing:'Mr. Salman Raza',email:'orders@getzpharma.com',creditDays:'30'}},
 {code:'SUP-1005',name:'GlaxoSmithKline',type:'Supplier',balanceType:'Credit',status:'Active',city:'Karachi',contact:'021-111-475-475',balance:262300,extra:{partyType:'Manufacturer',dealing:'Ms. Hina Qureshi',email:'supply@gsk.com.pk',creditDays:'45'}},
 {code:'SUP-1006',name:'The Searle Company',type:'Supplier',balanceType:'Credit',status:'Active',city:'Karachi',contact:'021-111-732-753',balance:0,extra:{partyType:'Manufacturer',dealing:'Mr. Adeel Khan',email:'sales@searle.com.pk',creditDays:'30'}},
 {code:'SUP-1007',name:'Horizon Traders',type:'Supplier',balanceType:'Credit',status:'Active',city:'Lahore',contact:'042-3576-1122',balance:96400,extra:{partyType:'Supplier',dealing:'Mr. Tariq Mehmood',email:'sales@horizon.com',creditDays:'15'}},
 {code:'SUP-1008',name:'MedCare Distributors',type:'Supplier',balanceType:'Credit',status:'Inactive',city:'Islamabad',contact:'051-2345-678',balance:0,extra:{partyType:'Distributor',dealing:'Mr. Faisal Iqbal',email:'info@medcare.com',creditDays:'30'}},
 {code:'SUP-1009',name:'Al-Noor Suppliers',type:'Supplier',balanceType:'Credit',status:'Active',city:'Lahore',contact:'042-3711-9090',balance:41200,extra:{partyType:'Supplier',dealing:'Mr. Noor Ahmed',email:'alnoor@suppliers.com',creditDays:'30'}},
 {code:'SUP-1010',name:'Health Plus Trading',type:'Supplier',balanceType:'Credit',status:'Active',city:'Karachi',contact:'021-3456-7890',balance:0,extra:{partyType:'Distributor',dealing:'Ms. Sana Malik',email:'contact@healthplus.com',creditDays:'45'}},
 {code:'SUP-1011',name:'Global Medical Co.',type:'Supplier',balanceType:'Credit',status:'Active',city:'Rawalpindi',contact:'051-5566-778',balance:128900,extra:{partyType:'Supplier',dealing:'Mr. Bilal Hussain',email:'sales@globalmed.com',creditDays:'60'}},
 {code:'SUP-1012',name:'Sunrise Enterprises',type:'Supplier',balanceType:'Credit',status:'Inactive',city:'Faisalabad',contact:'041-2233-445',balance:0,extra:{partyType:'Supplier',dealing:'Mr. Kamran Ali',email:'sunrise@enterprise.com',creditDays:'15'}},
 {code:'SUP-1013',name:'City Pharma',type:'Supplier',balanceType:'Credit',status:'Active',city:'Lahore',contact:'042-3588-6677',balance:57800,extra:{partyType:'Distributor',dealing:'Ms. Ayesha Noor',email:'info@citypharma.com',creditDays:'30'}},
 {code:'SUP-1014',name:'United Supplies',type:'Supplier',balanceType:'Credit',status:'Active',city:'Multan',contact:'061-4455-667',balance:0,extra:{partyType:'Supplier',dealing:'Mr. Umar Farooq',email:'uk@unitedsupplies.com',creditDays:'30'}},
 {code:'SUP-1015',name:'Metro Traders',type:'Supplier',balanceType:'Credit',status:'Active',city:'Karachi',contact:'021-3299-8811',balance:73600,extra:{partyType:'Supplier',dealing:'Mr. Zeeshan Ahmed',email:'metro@traders.com',creditDays:'45'}},
 {code:'DEP-04',name:'Prescription Medicines',type:'Department',balanceType:'—',status:'Active',city:'Lahore',contact:'—',balance:0},
 {code:'DOC-014',name:'Dr. Sana Iqbal',type:'Doctor',balanceType:'—',status:'Active',city:'Lahore',contact:'0300-8201144',balance:0},
]
export const seedCheques: BankCheque[] = [
 {id:'CHQ-01',no:'441290',date:'25 Aug 2026',bank:'Meezan Bank — 8721',party:'Shifa Medical Centre',amount:214000,status:'Presented'},
 {id:'CHQ-02',no:'552118',date:'22 Aug 2026',bank:'HBL — 2294',party:'Adeel Pharmacy',amount:96000,status:'In hand'},
 {id:'CHQ-03',no:'339904',date:'18 Aug 2026',bank:'Meezan Bank — 8721',party:'Walk-in cheque',amount:75000,status:'Cleared'},
 {id:'CHQ-04',no:'661201',date:'15 Aug 2026',bank:'HBL — 2294',party:'New World Traders',amount:125000,status:'Dishonoured'},
]
export const users: UserAccount[] = [
 {id:'USR-001',name:'Ahmed Raza',role:'Owner',branch:'Lahore Main',email:'ahmed.r@bhattitraders.pk',twoFactor:true,status:'Active',lastActive:'Just now',modules:['Dashboard','Masters','Products','Purchasing','Sales & POS','Inventory','Demand & PO','Cash, Bank & GL','HR & Payroll','Admin & Control','Reports'],
  sessions:[{device:'MacBook Pro · Chrome',location:'Lahore, PK',lastActive:'Just now',ip:'39.62.12.84'},{device:'iPhone 15 · Safari',location:'Lahore, PK',lastActive:'2 hours ago',ip:'39.62.48.11'}],
  audit:[{date:'30 Aug 2026 · 09:12',action:'Login',detail:'Signed in from Lahore, PK',user:'Ahmed Raza'},{date:'29 Aug 2026 · 18:40',action:'Role change',detail:'Granted Auditor read-only access',user:'Ahmed Raza'}]},
 {id:'USR-014',name:'Sana Javed',role:'Pharmacist',branch:'Lahore Main',email:'sana.j@bhattitraders.pk',twoFactor:true,status:'Active',lastActive:'8 min ago',modules:['Dashboard','Products','Sales & POS','Inventory','Reports'],
  sessions:[{device:'Lenovo ThinkPad · Chrome',location:'Lahore, PK',lastActive:'8 min ago',ip:'39.63.77.20'}],
  audit:[{date:'30 Aug 2026 · 10:02',action:'Purchase posted',detail:'PUR-2026-0184 · Augmentin 625mg',user:'Sana Javed'},{date:'30 Aug 2026 · 09:41',action:'Sale posted',detail:'INV-26814 · Shifa Medical Centre',user:'Sana Javed'}]},
 {id:'USR-027',name:'Hira Ali',role:'Accountant',branch:'Lahore Main',email:'hira.a@bhattitraders.pk',twoFactor:false,status:'Active',lastActive:'22 min ago',modules:['Dashboard','Cash, Bank & GL','HR & Payroll','Reports'],
  sessions:[{device:'Dell Latitude · Edge',location:'Lahore, PK',lastActive:'22 min ago',ip:'39.62.201.5'}],
  audit:[{date:'30 Aug 2026 · 08:55',action:'Journal posted',detail:'JV-2026-0405 · Inventory purchase',user:'Hira Ali'}]},
 {id:'USR-019',name:'Bilal Khan',role:'Salesman',branch:'Rawalpindi',email:'bilal.k@bhattitraders.pk',twoFactor:true,status:'Away',lastActive:'Yesterday',modules:['Dashboard','Sales & POS','Products'],
  sessions:[{device:'Samsung Galaxy · Chrome',location:'Rawalpindi, PK',lastActive:'Yesterday · 17:02',ip:'39.63.140.88'}],
  audit:[{date:'29 Aug 2026 · 16:12',action:'Sale posted',detail:'INV-26811 · Ventolin Inhaler',user:'Bilal Khan'}]},
 {id:'USR-028',name:'Ayesha Noor',role:'Accountant',branch:'Lahore Main',email:'ayesha.n@bhattitraders.pk',twoFactor:true,status:'Active',lastActive:'12 min ago',modules:['Dashboard','Cash, Bank & GL','HR & Payroll','Reports'],
  sessions:[{device:'MacBook Air · Chrome',location:'Lahore, PK',lastActive:'12 min ago',ip:'39.62.90.44'}],
  audit:[{date:'30 Aug 2026 · 08:10',action:'Voucher created',detail:'CRV-2026-0102 · Adeel Pharmacy',user:'Ayesha Noor'}]},
 {id:'USR-029',name:'Usman Ali',role:'Purchase & Inventory',branch:'Lahore Main',email:'usman.a@bhattitraders.pk',twoFactor:false,status:'Active',lastActive:'45 min ago',modules:['Dashboard','Masters','Products','Purchasing','Inventory','Demand & PO','Reports'],
  sessions:[{device:'Lenovo ThinkPad · Chrome',location:'Lahore, PK',lastActive:'45 min ago',ip:'39.63.201.9'}],
  audit:[{date:'30 Aug 2026 · 07:40',action:'Purchase draft',detail:'PUR-2026-0182 · Abbott Laboratories',user:'Usman Ali'}]},
]

export const employees = [
 ['BT-001','Ahmed Raza','Branch Manager','Lahore','Rs 145,000','Present'],['BT-014','Sana Javed','Pharmacist','Lahore','Rs 98,000','Present'],['BT-019','Bilal Khan','Sales Executive','Rawalpindi','Rs 72,500','Field'],['BT-027','Hira Ali','Accounts Officer','Lahore','Rs 85,000','Present'],['BT-031','Umar Farooq','Store Keeper','Faisalabad','Rs 58,000','Leave'],
 ['BT-036','Zainab Raza','Sales Executive','Lahore','Rs 70,000','Present'],['BT-041','Hamza Butt','Delivery Supervisor','Karachi','Rs 65,000','Pending'],['BT-048','Fatima Noor','Accounts Assistant','Lahore','Rs 55,000','Present'],['BT-052','Kashif Ali','Purchase Officer','Karachi','Rs 70,000','Present'],['BT-060','Nida Shah','Office Assistant','Islamabad','Rs 50,000','Present'],
]

export const roles: Record<string,string[]> = {
  Owner:['all'], Pharmacist:['Dashboard','Products','Sales & POS','Inventory','Reports'],
  'Purchase & Inventory':['Dashboard','Masters','Products','Purchasing','Inventory','Demand & PO','Reports'],
  Accountant:['Dashboard','Masters','Cash, Bank & GL','HR & Payroll','Reports'], Salesman:['Dashboard','Sales & POS','Products'], Auditor:['Dashboard','Cash, Bank & GL','Reports','Admin & Control'],
}
export const actionPermissions:Record<string,string[]>={Owner:['all'],Pharmacist:['sale:create'],Accountant:['master:create','voucher:create','payment:create','report:export'],'Purchase & Inventory':['master:create','purchase:create','po:create','stock:transfer','report:export'],Salesman:['sale:create'],Auditor:['report:export']}

export const reports: ReportDef[] = [
 {slug:'sales-register',name:'Sales register',description:'Every posted sale — mode, product, value and status',icon:'ReceiptText',category:'Sales',source:'sales',columns:[{key:'id',label:'Invoice'},{key:'date',label:'Date'},{key:'customer',label:'Customer'},{key:'mode',label:'Mode'},{key:'product',label:'Product'},{key:'qty',label:'Qty'},{key:'amount',label:'Amount'},{key:'status',label:'Status'}]},
 {slug:'purchases-register',name:'Purchases register',description:'Supplier invoices received — value and posting status',icon:'ShoppingBag',category:'Purchasing',source:'purchases',columns:[{key:'id',label:'Purchase'},{key:'date',label:'Date'},{key:'supplier',label:'Supplier'},{key:'product',label:'Product'},{key:'qty',label:'Qty'},{key:'amount',label:'Amount'},{key:'status',label:'Status'}]},
 {slug:'stock-valuation',name:'Stock & valuation',description:'Batch-wise quantity and value on hand',icon:'Boxes',category:'Inventory',source:'stock',columns:[{key:'product',label:'Product'},{key:'batches',label:'Batches'},{key:'stock',label:'Packs'},{key:'value',label:'Value'},{key:'status',label:'Health'}]},
 {slug:'expiry-exposure',name:'Expiry exposure',description:'Value at risk by expiry window',icon:'Clock3',category:'Inventory',source:'expiry',columns:[{key:'window',label:'Window'},{key:'count',label:'Batches'},{key:'units',label:'Units'},{key:'value',label:'Value at risk'}]},
 {slug:'trial-balance',name:'Trial balance',description:'Debit and credit totals across the chart of accounts',icon:'Landmark',category:'Finance',source:'trial',columns:[{key:'account',label:'Account'},{key:'debit',label:'Debit'},{key:'credit',label:'Credit'}]},
 {slug:'general-ledger',name:'General ledger',description:'Detailed debit and credit history from journal vouchers',icon:'FileText',category:'Finance',source:'ledger',columns:[{key:'date',label:'Date'},{key:'id',label:'Journal'},{key:'account',label:'Account'},{key:'dr',label:'Debit'},{key:'cr',label:'Credit'}]},
 {slug:'profit-loss',name:'Income statement',description:'Revenue, cost of sales and expenses for the period',icon:'ChartNoAxesCombined',category:'Finance',source:'pnl',columns:[{key:'heading',label:'Heading'},{key:'value',label:'Amount'}]},
 {slug:'balance-sheet',name:'Balance sheet',description:'Assets, liabilities and net worth as at period end',icon:'WalletCards',category:'Finance',source:'bs',columns:[{key:'heading',label:'Heading'},{key:'value',label:'Amount'}]},
 {slug:'payroll-register',name:'Payroll register',description:'Employee compensation by designation and branch',icon:'Users',category:'HR',source:'employees',columns:[{key:'id',label:'ID'},{key:'name',label:'Employee'},{key:'designation',label:'Designation'},{key:'branch',label:'Branch'},{key:'salary',label:'Gross'},{key:'status',label:'Today'}]},
]

export const seedPurchaseOrders: PurchaseOrder[] = [
 {id:'PO-00048',date:'18-09-2026',supplier:'Allied Traders',amount:2032.5,status:'Pending',expected:'25-09-2026',owner:'Saim Javed',flag:'Urgent',lines:[{product:'Panadol 500mg',qty:12,cost:88},{product:'Brufen 400mg',qty:6,cost:96},{product:'Disprin 300mg',qty:4,cost:30}]},
 {id:'PO-00047',date:'17-09-2026',supplier:'Pharma Plus',amount:1240,status:'Draft',expected:'24-09-2026',owner:'Saim Javed',lines:[{product:'Augmentin 625mg',qty:5,cost:160},{product:'Risek 20mg',qty:4,cost:70},{product:'Calpol Suspension',qty:3,cost:53}]},
 {id:'PO-00046',date:'16-09-2026',supplier:'Metro Supplies',amount:856,status:'Approved',expected:'23-09-2026',owner:'Fahad Ali',lines:[{product:'Dettol Soap',qty:10,cost:34},{product:'Dove Soap',qty:8,cost:29},{product:'Colgate Toothpaste',qty:6,cost:32},{product:'Nivea Body Lotion',qty:2,cost:36}]},
 {id:'PO-00045',date:'14-09-2026',supplier:'Global Distributors',amount:3500,status:'Received',expected:'21-09-2026',owner:'Saim Javed',partial:true,lines:[{product:'Ensure Powder',qty:6,cost:250},{product:'Bournvita',qty:8,cost:130},{product:'Panadol 500mg',qty:10,cost:96}]},
 {id:'PO-00044',date:'12-09-2026',supplier:'Khan & Sons',amount:720,status:'Pending',expected:'19-09-2026',owner:'Areeba Khan',flag:'High Value',lines:[{product:'Risek 20mg',qty:4,cost:80},{product:'Brufen 400mg',qty:5,cost:44},{product:'Disprin 300mg',qty:6,cost:30}]},
 {id:'PO-00043',date:'10-09-2026',supplier:'HealthPlus',amount:1950,status:'Approved',expected:'18-09-2026',owner:'Saim Javed',lines:[{product:'Augmentin 625mg',qty:8,cost:130},{product:'Nexium 40mg',qty:6,cost:95}]},
 {id:'PO-00042',date:'08-09-2026',supplier:'MedCare',amount:630,status:'Draft',expected:'16-09-2026',owner:'Areeba Khan',lines:[{product:'Calpol Suspension',qty:5,cost:70},{product:'Dettol Soap',qty:8,cost:35}]},
 {id:'PO-00041',date:'06-09-2026',supplier:'Al-Rehman Co.',amount:2800,status:'Received',expected:'14-09-2026',owner:'Fahad Ali',lines:[{product:'Ensure Powder',qty:10,cost:180},{product:'Bournvita',qty:6,cost:130}]},
 {id:'PO-00040',date:'02-09-2026',supplier:'Star Chemicals',amount:1120,status:'Pending',expected:'12-09-2026',owner:'Fahad Ali',flag:'Due Today',lines:[{product:'Dove Soap',qty:12,cost:52},{product:'Colgate Toothpaste',qty:8,cost:40},{product:'Nivea Body Lotion',qty:4,cost:45}]},
 {id:'PO-00039',date:'01-09-2026',supplier:'LifeCare Pharma',amount:980,status:'Cancelled',expected:'09-09-2026',owner:'Saim Javed',lines:[{product:'Panadol 500mg',qty:6,cost:90},{product:'Brufen 400mg',qty:4,cost:80},{product:'Risek 20mg',qty:2,cost:60}]},
 {id:'PO-00038',date:'28-08-2026',supplier:'Family Care',amount:450,status:'Draft',expected:'06-09-2026',owner:'Saim Javed',lines:[{product:'Disprin 300mg',qty:8,cost:32},{product:'Calpol Suspension',qty:4,cost:48}]},
 {id:'PO-00037',date:'25-08-2026',supplier:'Universal Traders',amount:2400,status:'Approved',expected:'03-09-2026',owner:'Areeba Khan',lines:[{product:'Nexium 40mg',qty:10,cost:120},{product:'Augmentin 625mg',qty:6,cost:140},{product:'Ensure Powder',qty:2,cost:180}]},
 {id:'PO-00034',date:'22-08-2026',supplier:'Bright Pharma',amount:670,status:'Received',expected:'30-08-2026',owner:'Areeba Khan',lines:[{product:'Dettol Soap',qty:6,cost:48},{product:'Dove Soap',qty:8,cost:30},{product:'Colgate Toothpaste',qty:4,cost:35},{product:'Bournvita',qty:2,cost:60}]},
 {id:'PO-00033',date:'20-08-2026',supplier:'National Medical',amount:510,status:'Cancelled',expected:'28-08-2026',owner:'Fahad Ali',lines:[{product:'Panadol 500mg',qty:4,cost:75},{product:'Risek 20mg',qty:3,cost:70}]},
]

export const seedChallans: DeliveryChallan[] = [
 {id:'DC-2026-0041',date:'22 Sep 2026',customer:'Shifa Medical Centre',address:'Block 12, Model Town, Lahore',invoiceRef:'INV-26814',vehicle:'LEA-4821',driver:'Rafiq Shah',lines:[{product:'Augmentin 625mg',pack:"10's",batch:'AU-514A',expiry:'2027-02-28',qty:4,bonus:0}],status:'Pending',preparedBy:'Ahmed Raza',notes:'Urgent — please deliver before noon.'},
 {id:'DC-2026-0040',date:'21 Sep 2026',customer:'Adeel Pharmacy',address:'Gulberg III, Lahore',invoiceRef:'INV-26812',vehicle:'LZN-1204',driver:'Naeem Butt',lines:[{product:'Risek 20mg',pack:"10's",batch:'RK-921',expiry:'2028-01-31',qty:12,bonus:0}],status:'Delivered',preparedBy:'Sana Javed',receivedBy:'M. Adeel'},
 {id:'DC-2026-0039',date:'20 Sep 2026',customer:'City Pharmacy',address:'Liberty Market, Lahore',invoiceRef:'INV-26810',vehicle:'LEA-4821',driver:'Rafiq Shah',lines:[{product:'Panadol 500mg',pack:"10's",batch:'PD-2408',expiry:'2027-08-31',qty:10,bonus:0},{product:'Calpol Suspension',pack:'60ml',batch:'CP-201B',expiry:'2026-12-31',qty:6,bonus:0}],status:'Delivered',preparedBy:'Ahmed Raza',receivedBy:'Ali Raza (stamp)'},
 {id:'DC-2026-0038',date:'19 Sep 2026',customer:'Hassan Medical Store',address:'Iqbal Town, Lahore',invoiceRef:'INV-26808',lines:[{product:'Humulin 70/30',pack:'Vial',batch:'HM-70X',expiry:'2026-10-31',qty:5,bonus:0},{product:'Lipiget 20mg',pack:"10's",batch:'LP-881',expiry:'2027-11-30',qty:8,bonus:1}],status:'Delivered',preparedBy:'Usman Ali',receivedBy:'Hassan (stamp)'},
 {id:'DC-2026-0037',date:'18 Sep 2026',customer:'Al-Noor Clinic',address:'DHA Phase 5, Lahore',invoiceRef:'INV-26807',vehicle:'LZN-1204',driver:'Naeem Butt',lines:[{product:'Ventolin Inhaler',pack:'1 inhaler',batch:'VN-721',expiry:'2027-03-31',qty:3,bonus:0},{product:'Augmentin 625mg',pack:"10's",batch:'AU-610B',expiry:'2027-12-31',qty:6,bonus:0}],status:'Pending',preparedBy:'Sana Javed'},
 {id:'DC-2026-0036',date:'17 Sep 2026',customer:'Fatima Hospital',address:'Johar Town, Lahore',invoiceRef:'INV-26806',vehicle:'LEA-4821',driver:'Rafiq Shah',lines:[{product:'Entamizole DS',pack:"10's",batch:'EN-113',expiry:'2027-06-30',qty:20,bonus:2}],status:'Delivered',preparedBy:'Ayesha Noor',receivedBy:'Dr. Fatima (stamp)'},
 {id:'DC-2026-0035',date:'16 Sep 2026',customer:'Shifa Medical Centre',address:'Block 12, Model Town, Lahore',invoiceRef:'INV-26805',vehicle:'LZN-1204',driver:'Naeem Butt',lines:[{product:'Augmentin 625mg',pack:"10's",batch:'AU-514A',expiry:'2027-02-28',qty:8,bonus:0},{product:'Panadol 500mg',pack:"10's",batch:'PD-2408',expiry:'2027-08-31',qty:20,bonus:0}],status:'Cancelled',preparedBy:'Ahmed Raza'},
 {id:'DC-2026-0034',date:'15 Sep 2026',customer:'Siddiq Dispensary',address:'Faisal Town, Lahore',invoiceRef:'INV-26803',vehicle:'LEA-4821',driver:'Rafiq Shah',lines:[{product:'Panadol 500mg',pack:"10's",batch:'PD-2408',expiry:'2027-08-31',qty:24,bonus:2},{product:'Risek 20mg',pack:"10's",batch:'RK-921',expiry:'2028-01-31',qty:6,bonus:0}],status:'Delivered',preparedBy:'Sana Javed',receivedBy:'Usman Siddiq'},
 {id:'DC-2026-0033',date:'14 Sep 2026',customer:'Rahima Medical',address:'Garden Town, Lahore',invoiceRef:'INV-26801',lines:[{product:'Lipiget 20mg',pack:"10's",batch:'LP-881',expiry:'2027-11-30',qty:10,bonus:0},{product:'Humulin 70/30',pack:'Vial',batch:'HM-70X',expiry:'2026-10-31',qty:4,bonus:0}],status:'Pending',preparedBy:'Ayesha Noor',notes:'Cold-chain item — keep refrigerated.'},
]
