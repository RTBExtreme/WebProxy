# WebProxy

Browse websites without any restrictions using just one webpage (easy to setup)

Demo at: https://rtbextreme.net/webproxy/index.html

Change "const PORT = 443;" to change port

How to run a WebProxy server:

Run these commands

git clone https://github.com/RTBExtreme/WebProxy.git

npm init -y

npm install express url fs compression https

node proxy-server.js

Also change the public/private keys they are public and for testing only!

or run for no HTTPS

node proxy-server-nohttps.js
