Verp (Very-easy Enterprise Resource Planning) is an ERP platform written in Typescript/Javascript based on Nodejs, and the web client-side follows the frontend development trio standard: JavaScript, HTML and CSS

1) written in just one programming language (Javascript/Typescript),
2) allows running on any operating system platform (Linux/Windows/MacOS),
3) easy to use (private server/cloud, web client/smart device),
4) easy to extend (install/uninstall modules on runtime).

Verp is inspired by Odoo/OpenErp. This is the first version, will be updated continuously. I hope everyone is interested in experiencing and contributing positive comments to help Verp become more complete.

Bug fixes, specifications and detailed instructions will be updated in the near future.

** Installation instructions:

1) Get the Verp 1.0

  > git clone https://github.com/tonyluong2025/verp.git

2) Install nodejs 20.15.1

  > https://nodejs.org/en/download/prebuilt-installer

3) Install typescript 5.3.3

  > https://www.typescriptlang.org/download/

4) Install postgres 12.20
  
  > https://www.enterprisedb.com/downloads/postgres-postgresql-downloads \
    Create user with permission create/remove database: \
    user: verp \
    pass: verp

5) Install Chrome to make report pdf

  > https://www.google.com/chrome

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

7) Isntall

  > npm i

8) Run a command line

  > ts-node ./src/index.ts

9) Access by a browser

  > http://localhost:7979 \
  (default password of master: admin)
