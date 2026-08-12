ENCORP SALARY PORTAL - RENDER DEPLOYMENT PACKAGE
================================================

This package is ready to place in a private GitHub repository and connect to Render.

IMPORTANT
---------
Render runs on the internet. Your SQL Server must be safely reachable from Render.
Do not publicly open SQL Server port 1433. Use a secure private connection or VPN.

RENDER SETUP
------------
1. Unzip this package and upload all files to a PRIVATE GitHub repository.
2. In Render, choose New > Blueprint.
3. Connect the private GitHub repository.
4. Render will read render.yaml and ask for these secret values:
   ENCORP_SQL_CONNECTION_STRING = the protected SQL Server connection string
   ENCORP_ADMIN_USERNAME = the login name for this portal
   ENCORP_ADMIN_PASSWORD = a strong login password
5. Finish the Blueprint setup and wait for the health check to pass.
6. Open the HTTPS address supplied by Render and sign in.

DATABASE NOTE
-------------
The website and PDF download will open on Render without exposing any password in this ZIP.
Saving, searching, updating, deleting, and exporting salary records require Render to have a
safe network route to the existing SQL Server.

HEALTH CHECK
------------
Render checks: /api/health

SECURITY
--------
Keep the GitHub repository private. Never commit settings.protected or real secret values.
