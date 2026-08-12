# Encorp Salary Portal

Encorp is an internal salary-management portal for creating, saving, finding,
exporting, and printing employee salary structures.

## Windows setup

1. Install Python 3.12 and the packages in `requirements.txt`.
2. Create `settings.protected` beside this README. It must contain the SQL
   Server connection string and password hashes for authorised users.
3. Run `python -m encorp_app --host 127.0.0.1 --port 3000`.
4. Open `http://127.0.0.1:3000/index.html`.

The protected settings file is excluded from Git and must never be placed in
the public `static` folder.
