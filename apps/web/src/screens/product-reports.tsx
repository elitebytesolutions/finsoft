'use client'
import { ArrowUpDown, Barcode, Building2, CalendarDays, ChartColumn, Clock3, Coins, History, Layers, List, Package, PackageX, ShoppingCart, Tag, UserRound, ChartNoAxesColumn } from 'lucide-react'
import { ReportStudioPage, type StudioConfig } from './report-studio'

const rows=[
 {sku:'P001',name:'Panadol 500mg',cls:'Medicines',brand:'GSK',qty:5200,cost:12.5,value:65000},
 {sku:'P002',name:'Dettol Soap',cls:'Personal Care',brand:'Reckitt',qty:3450,cost:95,value:327750},
 {sku:'P003',name:'Colgate Toothpaste',cls:'Personal Care',brand:'Colgate',qty:2800,cost:110,value:308000},
 {sku:'P004',name:'Dove Soap',cls:'Personal Care',brand:'Unilever',qty:4200,cost:85,value:357000},
 {sku:'P005',name:'Cetaphil Face Wash',cls:'Cosmetics',brand:'Galderma',qty:1950,cost:1250,value:2437500},
 {sku:'P006',name:'Nivea Body Lotion',cls:'Personal Care',brand:'Beiersdorf',qty:3100,cost:450,value:1395000},
 {sku:'P007',name:'Ensure Powder',cls:'Nutrition',brand:'Abbott',qty:1780,cost:2450,value:4361000},
 {sku:'P008',name:'Bournvita',cls:'Nutrition',brand:'Mondelez',qty:2640,cost:1150,value:3036000},
 {sku:'P009',name:'Nexium 40mg',cls:'Medicines',brand:'AstraZeneca',qty:640,cost:95,value:60800},
 {sku:'P010',name:'Disprin 300mg',cls:'Medicines',brand:'Bayer',qty:1560,cost:15,value:23400},
]

const config:StudioConfig={
 module:'Inventory',crumb:'Product Report Studio',title:'Product Report Studio',description:'Select a report, set your options and generate professional product reports.',tagline:<>Smarter Products.<br/>Better Decisions.</>,
 tabs:[
  {key:'purchase',label:'Purchase Record',icon:ShoppingCart},{key:'sale',label:'Sale Record',icon:ChartColumn},{key:'history',label:'Product History',icon:History},{key:'upc',label:'UPC Products',icon:Barcode},
  {key:'list',label:'Product List',icon:List},{key:'dead',label:'Dead Products',icon:PackageX},{key:'waiting',label:'Waiting Products',icon:Clock3},
 ],
 filters:[
  {kind:'date',label:'Date Range',icon:CalendarDays,options:['As On Date','Date Range','Month to Date'],date:'14 Sep 2026'},
  {kind:'select',label:'Company',icon:Building2,options:['All Companies','GSK','Abbott','Unilever']},
  {kind:'select',label:'Product Class',icon:Tag,options:['All Product Classes','Medicines','Personal Care','Cosmetics','Nutrition']},
  {kind:'select',label:'Brand / Principal / Company',icon:UserRound,options:['All Brands','GSK','Reckitt','Colgate','Unilever','Abbott']},
  {kind:'radio',label:'Report Scope',icon:Layers,options:['All Products','One Product','Product Class','Product Type']},
  {kind:'search',label:'Product',icon:Package,placeholder:'Search product name...'},
  {kind:'search',label:'UPC Code',icon:Barcode,placeholder:'Enter UPC code...'},
  {kind:'select',label:'View By / Group By',icon:Layers,options:['Product Class','Brand','Company','None']},
  {kind:'sort',label:'Sort By',icon:ArrowUpDown,options:['Product Name','SKU','Purchase Qty','Total Value']},
 ],
 footToggle:'Show only inactive products',
 stats:[{label:'Total Products',value:'1,245',icon:Package},{label:'Total Purchase Qty',value:'56,320',icon:ShoppingCart},{label:'Total Purchase Value',value:'PKR 12,845,600',icon:Coins},{label:'Active Products',value:'1,120',icon:ChartNoAxesColumn}],
 columns:[{key:'sku',label:'SKU'},{key:'name',label:'Product Name'},{key:'cls',label:'Product Class'},{key:'brand',label:'Brand / Company'},{key:'qty',label:'Purchase Qty',num:true},{key:'cost',label:'Unit Cost',num:true},{key:'value',label:'Total Value',num:true}],
 rows,reportName:'Product Purchase Report',
 summary:[['Total Products','1,245'],['Total Purchase Quantity','56,320'],['Total Purchase Value','PKR 12,845,600']],
 criteria:[['Date Range','01 Sep 2026 - 14 Sep 2026'],['Company','All Companies'],['Product Class','All Product Classes'],['Brand','All Brands'],['Sorted By','Product Name (Ascending)']],
 presets:[{name:'Default Product Purchase',sub:'Purchase Record · All Companies'},{name:'Dead Products - All Warehouses',sub:'Dead Products · All Warehouses'},{name:'UPC Product Detail',sub:'UPC Products · Detailed'},{name:'Product History - Detailed',sub:'Product History · Last 6 Months'}],
}

export function ProductReports(){return <ReportStudioPage config={config}/>}
