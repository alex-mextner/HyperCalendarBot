"""Read public profile fields for an already known numeric Telegram peer."""
import asyncio,json,os,sys
from pyrogram import Client
from service_session import start_service_session
from mtproto_lock import session_lock
async def main(user_id):
    if user_id<=0: raise ValueError('Invalid Telegram ID')
    with session_lock():
        app=Client('voice_caller',api_id=int(os.environ.get('MTPROTO_API_ID','0')),api_hash=os.environ.get('MTPROTO_API_HASH',''),workdir='data')
        await start_service_session(app)
        try:
            user=await app.get_users(user_id)
            if user.id!=user_id: raise ValueError('IDENTITY_MISMATCH')
            data={'id':user.id,'deleted':bool(user.is_deleted)}
            if user.first_name: data['firstName']=user.first_name
            if user.username: data['username']=user.username
            print(json.dumps(data))
        finally: await app.stop()
if __name__=='__main__': asyncio.run(main(int(sys.argv[1])))
