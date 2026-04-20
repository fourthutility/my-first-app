-- ============================================================
--  IB South End Tracker — Migration v2
--  Adds CoStar property fields + seeds 66 existing properties
--  Paste into: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- 1. ADD NEW COLUMNS to existing projects table
alter table projects
  add column if not exists property_name      text,
  add column if not exists property_type      text,
  add column if not exists star_rating        integer,
  add column if not exists leed_certified     text,
  add column if not exists num_stories        integer,
  add column if not exists building_class     text,
  add column if not exists total_available_sf integer,
  add column if not exists leasing_company    text,
  add column if not exists percent_leased     numeric(6,2),
  add column if not exists year_built         integer,
  add column if not exists year_renovated     integer;

-- 2. ENRICH existing pipeline rows that overlap with CoStar data

update projects set
  property_name='Vantage South End - East Tower', property_type='Office', star_rating=5,
  num_stories=11, building_class='A', total_available_sf=4751,
  leasing_company='Spectrum Companies', percent_leased=98.38, year_built=2022
where address='1120 S Tryon St';

update projects set
  property_name='1301 at Centre South', property_type='Office', star_rating=4,
  num_stories=12, building_class='A', total_available_sf=312000,
  leasing_company='Foundry Commercial', percent_leased=0.00, year_built=2027
where address='1301 South Blvd';

update projects set
  property_type='Multi-Family', star_rating=3, num_stories=15, building_class='B',
  year_built=2025
where address='1603 South Blvd';

update projects set
  property_name='Queensbridge Collective', property_type='Office', star_rating=5,
  num_stories=42, building_class='A', total_available_sf=537962,
  leasing_company='CBRE', percent_leased=35.80, year_built=2026
where address='1111 S Tryon St';

-- 3. INSERT 66 CoStar existing/proposed properties
--    (6 addresses already in pipeline were skipped:
--     1120 S Tryon St, 1301 South Blvd, 1603 South Blvd,
--     1111 S Tryon St, 1102 South Tryon St, 2500 Distribution St)

insert into projects
  (address, property_name, owner_developer, status, property_type,
   star_rating, leed_certified, num_stories, building_class,
   total_available_sf, leasing_company, percent_leased,
   year_built, year_renovated)
values
  ('704 W Tremont Ave','704 at The Quarter','Abacus Capital','Existing','Multi-Family',4,null,4,'A',3174,null,null,2024,null),
  ('2025 Cleveland Ave','The Campbell','Abacus Capital Group','Existing','Multi-Family',4,null,12,'A',1047,null,null,2024,null),
  ('1100 South Blvd','1100 South','Affinius Capital LLC','Existing','Multi-Family',4,null,5,'A',null,null,null,2015,null),
  ('200 West Blvd','The Square','Affinius Capital LLC','Existing','Office',4,'LEED Certified - Silver',10,'A',null,null,100.00,2021,null),
  ('1427 South Blvd',null,'Akridge','Proposed','Multi-Family',4,null,31,'A',null,null,null,2027,null),
  ('2408 South Blvd','The Boulevard a Broadstone Community','Alliance Residential Company','Existing','Multi-Family',5,null,8,'A',3000,null,null,2024,null),
  ('100 W Worthington Ave','Lowe''s Tech Hub','Apollo Net Lease Co., LLC','Existing','Office',5,null,23,'A',2542,'Thrift Commercial Real Estate Services',100.00,2021,null),
  ('335 Doggett St','AVA South End','AvalonBay Communities, Inc.','Existing','Multi-Family',4,null,4,'A',null,null,null,2013,null),
  ('1932 Hawkins St','Avalon Hawk','AvalonBay Communities, Inc.','Existing','Multi-Family',4,null,13,'A',null,null,null,2020,null),
  ('2250 Hawkins St','Avalon South End','AvalonBay Communities, Inc.','Existing','Multi-Family',4,null,6,'A',null,null,null,2020,null),
  ('1616 Camden Rd','1616 Center','Beacon Development Company','Existing','Office',4,null,5,'A',36801,'Beacon Development Company',86.31,2015,null),
  ('2201 South Blvd',null,'Beacon Development Company','Existing','Office',3,null,4,'B',null,'Beacon Development Company',100.00,2008,null),
  ('1750 Camden Rd','Camden Gallery','Camden Property Trust','Existing','Multi-Family',4,null,5,'A',1800,'Ascent Real Estate Partners',null,2016,null),
  ('1510 Scott Ave','Camden Dilworth','Camden Property Trust','Existing','Multi-Family',4,null,4,'B',null,null,null,2005,null),
  ('2300 South Blvd','Camden Southline','Camden Property Trust','Existing','Multi-Family',4,null,5,'A',null,null,null,2015,null),
  ('1205 S Tryon St','Camden South End','Camden Property Trust','Existing','Multi-Family',4,null,4,'B',null,null,null,2002,null),
  ('1600-1614 Camden Rd',null,'Catalyst Capital Partners LLC','Proposed','Multi-Family',4,null,30,'A',null,null,null,2025,null),
  ('327 W Tremont Ave','The Penrose','CBRE Investment Management','Existing','Multi-Family',5,null,4,'A',null,null,null,2018,null),
  ('1001 Blythe Blvd','Medical Center Plaza','Charlotte Mecklenburg Hospital','Existing','Office',3,null,7,'A',null,'Charlotte Mecklenburg Hospital',100.00,1989,null),
  ('1150 Blythe Blvd','David L. Conlan Rehabilitation Center','Charlotte Mecklenburg Hospital Authority','Existing','Office',4,null,5,'A',null,null,100.00,2023,null),
  ('1700 Camden Rd','The Kingston','Collett & Associates','Existing','Multi-Family',3,null,4,'B',null,'Real Estate Development Partners',null,2003,null),
  ('1425 Winnifred St','The Winnifred','Collett Capital','Existing','Multi-Family',4,null,8,'A',2123,'Ascent Real Estate Partners',null,2020,null),
  ('222 West Blvd','The Winston Apartments','Collett Capital','Existing','Multi-Family',4,null,7,'A',988,null,null,2022,null),
  ('2225 Hawkins St','Cortland South End','Cortland','Existing','Multi-Family',4,null,4,'B',null,null,null,2009,null),
  ('1414 S Tryon St','RailYard North Tower','Cousins Properties','Existing','Office',5,'LEED Certified - Silver',8,'A',12354,'Thrift Commercial Real Estate Services',100.00,2019,null),
  ('1422 S Tryon St','RailYard South Tower','Cousins Properties','Existing','Office',5,'LEED Certified - Silver',8,'A',4114,'Thrift Commercial Real Estate Services',97.48,2019,null),
  ('1415 Vantage Park Dr','Vantage South End - West Tower','Cousins Properties','Existing','Office',5,null,11,'A',2752,'Spectrum Companies',99.18,2021,null),
  ('306 W Tremont Ave','Tremont Alley','Cousins Properties','Proposed','Multi-Family',4,null,19,'B',null,null,null,null,null),
  ('1300 South Blvd',null,'Cynthia Woodlief','Existing','Office',3,null,4,'B',23500,'Cushman & Wakefield',35.21,1920,null),
  ('1515 S Tryon St','Dimensional Place','Dimensional','Existing','Office',4,'LEED Certified - Gold',8,'A',1633,'MPV Properties',99.42,2019,null),
  ('325 Arlington Ave','The Arlington','East West Capital, LLC','Existing','Office',4,null,16,'A',null,'David Dorsch CRE, LLC',100.00,2002,null),
  ('1449 S Church St','District Flats at Summit Church','FCA Partners','Existing','Multi-Family',4,null,6,'B',null,null,null,2015,null),
  ('109 W Catherine St','Catherine 36','Gateway Communities','Existing','Multi-Family',4,null,4,'B',null,null,null,2014,null),
  ('124 E Kingston Ave','Kingston','Greystar Real Estate Partners','Existing','Multi-Family',4,null,24,'A',8836,null,null,2024,null),
  ('711 E Morehead St','Hanover Dilworth','Hanover Company','Existing','Multi-Family',5,null,15,'A',null,null,null,2024,null),
  ('126 New Bern St','Fountains Southend','Independence Realty Trust, Inc.','Existing','Multi-Family',4,null,4,'A',null,null,null,2013,null),
  ('400 East Blvd',null,'Inlivian','Existing','Office',3,null,4,'B',null,null,100.00,1968,2013),
  ('1312 S College St','Mosaic South End','JPMorgan Chase & Co.','Existing','Multi-Family',3,null,5,'B',null,null,null,2010,null),
  ('2200 Dunavant St','Hawkins Press','Kettler Management Inc.','Existing','Multi-Family',4,null,8,'A',null,null,null,2024,null),
  ('2520 South Blvd','Selene at Southline','Kohlberg Kravis Roberts & Co. L.P.','Existing','Multi-Family',4,'LEED Certified - Silver',5,'A',null,null,null,2017,null),
  ('1200 S Mint St','Link Apartments Mint Street','Link Apartments','Existing','Multi-Family',4,null,7,'A',null,null,null,2022,null),
  ('1106 Euclid Ave','The Lexington Dilworth','Marsh Properties, LLC','Existing','Multi-Family',4,null,5,'A',null,null,null,2016,null),
  ('125 W Tremont Ave','Ashton South End','MetLife Real Estate Investments','Existing','Multi-Family',4,null,11,'A',null,null,null,2008,null),
  ('222 E Bland St','MAA South Line','Mid-America Apartment Communities, Inc.','Existing','Multi-Family',4,'LEED Certified - Silver',4,'A',null,null,null,2009,null),
  ('1225 S Church St','MAA 1225','Mid-America Apartment Communities, Inc.','Existing','Multi-Family',4,null,4,'A',null,'Argos Real Estate Advisors',null,2010,null),
  ('1225 Winnifred St',null,'MPV Properties','Existing','Office',4,null,4,'A',null,null,100.00,2019,null),
  ('131 Poindexter Dr','Silos South End','Nuveen','Existing','Multi-Family',4,null,4,'B',null,null,null,2013,null),
  ('1020 S Tryon St','Carson South End','Nuveen','Proposed','Multi-Family',4,null,31,'B',null,null,null,2026,null),
  ('2151 Hawkins St','The Line','Portman Holdings','Existing','Office',5,null,16,'A',11681,'Foundry Commercial',96.38,2021,null),
  ('2161 Hawkins St','Linea','Portman Holdings','Existing','Multi-Family',4,null,24,'A',null,null,null,2025,null),
  ('421 W Tremont Ave','Everly','Ram Realty','Existing','Multi-Family',4,null,6,'A',null,null,null,2024,null),
  ('536 W Tremont Ave','The Raven','RangeWater Real Estate','Existing','Multi-Family',4,null,5,'B',null,null,null,2023,null),
  ('2100 South Blvd','The Atherton','RREEF Property Trust, Inc.','Existing','Multi-Family',4,null,5,'B',null,null,null,2019,null),
  ('1315 East Blvd','The Dilworth','Southworth Realty Ventures LLC','Existing','Multi-Family',3,null,5,'B',768,'Legacy Real Estate Advisors',null,2003,null),
  ('1001 Morehead Square Dr','The Offices at Carson Station','Spectrum Companies','Existing','Office',4,'LEED Certified - Silver',6,'A',25023,'Spectrum Companies',84.86,2001,null),
  ('1115 S Mint St','The Prospect','Spectrum Companies','Existing','Multi-Family',4,null,8,'A',8592,'Thrift Commercial Real Estate Services',null,2023,null),
  ('315 Arlington Ave','The Arlington Condos','Stahlschmidt Tim D','Existing','Multi-Family',4,null,22,'B',null,'MECA Commercial Real Estate',null,2003,null),
  ('110 East Blvd','110 East','Stiles Retail Group','Existing','Office',5,null,24,'A',356036,'Trinity Partners',3.77,2024,null),
  ('1300 S Mint St','Historic Textile Supply','Taylor & Morgan, CPA','Existing','Office',2,null,4,'B',1341,'Whiteside Properties',100.00,1920,1998),
  ('2100 S Tryon St',null,'Vision Ventures','Existing','Office',4,null,4,'A',18593,'Lincoln Harris',89.20,2020,null),
  ('2115-2135 Southend Dr','The Village at Southend',null,'Existing','Multi-Family',3,null,4,'B',3140,'Ascent Real Estate Partners',null,2004,null),
  ('310 Arlington Ave',null,null,'Existing','Multi-Family',3,null,4,'B',null,null,null,1920,2022),
  ('205 Foster Ave','Foster Flats',null,'Existing','Multi-Family',3,null,6,'B',null,null,null,2024,null),
  ('115 E Park Ave',null,null,'Existing','Multi-Family',3,null,4,'B',null,'Piedmont Properties of the Carolinas, Inc.',null,2002,null),
  ('301 E Tremont Ave',null,null,'Existing','Multi-Family',3,null,4,'B',null,null,null,2008,null),
  ('400 W Tremont Ave','Tremont Square Townhomes',null,'Existing','Multi-Family',3,null,4,'B',null,null,null,2021,null);

-- Done! You should now have 94 total rows (28 pipeline + 66 CoStar).
-- select status, count(*) from projects group by status order by count desc;
