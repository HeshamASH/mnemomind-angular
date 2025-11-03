
# import os
# from google_auth_oauthlib.flow import Flow
# from google.oauth2.credentials import Credentials
# from googleapiclient.discovery import build

# # This is the scope that your application will request from the user.
# # For this application, we need to read files from Google Drive and create new files (for the export to sheets feature).
# SCOPES = [
#     'https://www.googleapis.com/auth/drive.readonly',
#     'https://www.googleapis.com/auth/drive.file'
# ]

# REDIRECT_URI = 'http://localhost:5173/api/auth/google/callback'

# def get_google_flow():
#     """Creates and returns a Google OAuth 2.0 Flow object."""
#     client_secrets = {
#         "web": {
#             "client_id": os.getenv("GOOGLE_CLIENT_ID"),
#             "client_secret": os.getenv("GOOGLE_CLIENT_SECRET"),
#             "auth_uri": "https://accounts.google.com/o/oauth2/auth",
#             "token_uri": "https://oauth2.googleapis.com/token",
#             "redirect_uris": [REDIRECT_URI]
#         }
#     }
#     return Flow.from_client_config(client_secrets, scopes=SCOPES, redirect_uri=REDIRECT_URI)

# def get_drive_service(credentials: Credentials):
#     """Returns a Google Drive API service object."""
#     return build('drive', 'v3', credentials=credentials)

# def get_sheets_service(credentials: Credentials):
#     """Returns a Google Sheets API service object."""
#     return build('sheets', 'v4', credentials=credentials)
