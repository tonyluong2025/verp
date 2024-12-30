Verp (Very-easy Enterprise Resource Planning) is an ERP server platform running on Nodejs written in Typescript/Javascript, and the webclient side follows the standard of the trio of frontend development: JavaScript, HTML, and CSS.

The author's point of view is that need a platform that can act as both an ERP and a more multi-purpose platform to serve small and medium-sized organizations and businesses with the following criteria:

1) only needs to be written in a single programming language (basically Javascript/Typescript),
2) allows running on any operating system platform (Linux/Windows/MacOS),
3) easy to use (private server/cloud, web client/smartdevice),
4) easy to extend (install/uninstall modules on runtime).

Through the aproaching of existing open source platforms, with my limitations, the author has not found any software that fully meets my requirements. The author has also combined various platforms and supporting software packages but found that those implementations are still limited.

Odoo/OpenERP, is an interesting inspiration, however it is written in Python for the server side, so the webclient needs to use some hybrid techniques to process the javascript language for some specifications defined on the server and client side. In some aspects, Python is a great programming language for the server and Javascript is also great but it is difficult to completely replace Python.

Through the efforts of applying, learning, inheriting and referencing Odoo/OpenERP and some other supporting packages of the community available on NPM, the author has tried to create the Verp platform to serve the above purpose and hopes that many people, especially the SME community, support with that idea. 

In the early stages, many source codes are taken and converted from Python for the main purpose of easy experience, reference and bug fixing. In the future, when the platform is stable enough, the architecture will be converted as appropriately as possible. Most of the web client packages are adopted from Odoo/OpenErp platform with compatibility tweaks to work smoothly with Nodejs server-side architecture. New improvements may need to be changed in the future to utilize the strengths of Nodejs as well as Javascript/Typescript.

This is the first version, which will be continuously updated. I hope many people are interested in experiencing and contributing positive comments to help Verp become more complete.

Bug patches, technical specifications and detailed instructions will be updated in the near future.

** Installation instructions:

1) Get the Verp 1.0

  git clone https://github.com/tonyluong2025/verp.git

2) Install nodejs 20.15.1

  https://nodejs.org/en/download/prebuilt-installer

3) Install typescript 5.3.3

  https://www.typescriptlang.org/download/

4) Install postgres 12.20
  
  https://www.enterprisedb.com/downloads/postgres-postgresql-downloads

  * Create user with permission create/remove database 
    user: verp
    pass: verp

5) Install Chrome to make report pdf

  https://www.google.com/chrome

6) Config verp .\src\config.json

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
  "smtpUser": "???@ethereal.email",\
  "smtpPassword": "???",\

7) Run

  ts-node ./src/index.ts

9) Access

  http://localhost:7979
