For Odoo/OpenERP lovers with a completely different experience using all Javascript/Typescript.

Verp (Very-easy Enterprise Resource Planning) is an ERP server platform running on Nodejs written in Typescript/Javascript, the webclient side follows the standard of the Javascript/CSS/HTML trio.

I need a platform that can act as both an ERP and a more multi-purpose platform to serve small and medium-sized organizations and businesses with the following criteria:

1) only needs to be written in a single programming language (basically Javascript/Typescript),
2) allows running on any operating system platform (Linux/Windows/MacOS),
3) easy to use (private server/cloud, web client/smartdevice),
4) easy to extend (install/uninstall modules on runtime).

Through the process of researching existing open source platforms, with my limited approach, I have not found any software that fully meets my requirements. The author has also combined various platforms and supporting software packages but found that those implementations are still limited.

Odoo/OpenERP, is an interesting inspiration, however it is written in Javascript for the server side, so the webclient needs to use some hybrid techniques to process the javascript language for some specifications defined on the server and client side. In some aspects, Javascript is a great programming language for the server and Javascript is also great but it is difficult to completely replace it.

Through the efforts of applying, learning, inheriting and referencing Odoo/OpenERP and some other supporting packages of the community available on NPM, the author has tried to create the Verp platform to serve the above purpose and hopes that many users, especially the SME community, will have people who agree with that idea. The open source Verp project is written entirely in Javascript/Typescript on the server side; the client side is Javascript/CSS/HTML. 

In the early stages, many source codes are taken and converted from Javascript for the main purpose of easy experience, reference and bug fixing. In the future, when the platform is stable enough, the architecture will be converted as appropriately as possible. Most of the webclient packages are adopted from Odoo/OpenERP platform with compatibility tweaks to work smoothly with Nodejs server-side architecture. New improvements may need to be changed in the future to utilize the strengths of Nodejs as well as Javascript/Typescript.

This is the first version, which will be continuously updated. I hope many people are interested in experiencing and contributing positive comments to help Verp become more complete.

Bug patches, technical specifications and detailed instructions will be updated in the near future.

** Installation instructions:

1) Install nodejs 20.15.1

  https://nodejs.org/en/download/prebuilt-installer

2) Install typescript 5.3.3

  https://www.typescriptlang.org/download/

3) Install postgres 12.20
  
  https://www.enterprisedb.com/downloads/postgres-postgresql-downloads

  * Create user with permissions create/remove database 
    user: verp
    pass: verp

4) Install Chrome to make report pdf

  https://www.google.com/chrome

5) Config verp .\src\config.json

  Verp (Very-easy Enterprise Resource Planning) is an ERP server platform running on Nodejs written in Typescript/Javascript, the webclient side follows the standard of the Javascript/CSS/HTML trio.

I need a platform that can act as both an ERP and a more multi-purpose platform to serve small and medium-sized organizations and businesses with the following criteria:

1) only needs to be written in a single programming language (basically Javascript/Typescript),
2) allows running on any operating system platform (Linux/Windows/MacOS),
3) easy to use (private server/cloud, web client/smartdevice),
4) easy to extend (install/uninstall modules on runtime).

Through the process of researching existing open source platforms, with my limited approach, I have not found any software that fully meets my requirements. The author has also combined various platforms and supporting software packages but found that those implementations are still limited.

Odoo/OpenERP, is an interesting inspiration, however it is written in Javascript for the server side, so the webclient needs to use some hybrid techniques to process the javascript language for some specifications defined on the server and client side. In some aspects, Javascript is a great programming language for the server and Javascript is also great but it is difficult to completely replace it.

Through the efforts of applying, learning, inheriting and referencing Odoo/OpenERP and some other supporting packages of the community available on NPM, the author has tried to create the Verp platform to serve the above purpose and hopes that many users, especially the SME community, will have people who agree with that idea. The open source Verp project is written entirely in Javascript/Typescript on the server side; the client side is Javascript/CSS/HTML. 

In the early stages, many source codes are taken and converted from Javascript for the main purpose of easy experience, reference and bug fixing. In the future, when the platform is stable enough, the architecture will be converted as appropriately as possible. Most of the webclient packages are adopted from Odoo/OpenERP platform with compatibility tweaks to work smoothly with Nodejs server-side architecture. New improvements may need to be changed in the future to utilize the strengths of Nodejs as well as Javascript/Typescript.

This is the first version, which will be continuously updated. I hope many people are interested in experiencing and contributing positive comments to help Verp become more complete.

Bug patches, technical specifications and detailed instructions will be updated in the near future.

** Installation instructions:

1) Install nodejs 20.15.1

  https://nodejs.org/en/download/prebuilt-installer

2) Install typescript 5.3.3

  https://www.typescriptlang.org/download/

3) Install postgres 12.20
  
  https://www.enterprisedb.com/downloads/postgres-postgresql-downloads

  * Create user with permissions create/remove database 
    user: verp
    pass: verp

4) Install Chrome to make report pdf

  https://www.google.com/chrome

5) Config verp .\src\config.json

  > "addonsPath": "./src/core/addons,./src/addons",\
  "chromePath": "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",\
  "dataDir": "C:\\Users\\Admin\\AppData\\Local\\Verp",\
  "dbHost": "localhost",\
  "dbDialect": "postgres",\
  "dbPort": 5432,\
  "dbUser": "verp",\
  "dbPassword": "verp",\
  "httpHostname": "localhost",\
  "httpPort": 7979,\
  "langCodes": [["vi_VN", "Tiếng Việt"], ["en_US", "English"]],\
  "smtpServer": "smtp.ethereal.email",\
  "smtpPort": 587,\
  "smtpSsl": "STARTTLS",\
  "smtpUser": "kaitlyn.jakubowski65@ethereal.email",\
  "smtpPassword": "kfxE17YHCd5dCDXara",

6) Run:

  ts-node ./src/index.ts

7) Access:

  http://localhost:7979

6) Run:

  ts-node ./src/index.ts

7) Access:

  http://localhost:7979
