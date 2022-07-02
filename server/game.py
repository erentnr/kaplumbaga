import os
from flask import Flask, request
from flask_socketio import SocketIO, join_room, leave_room, emit

APP_SECRET = os.environ.get('SECRET_KEY', None)

app = Flask(__name__)
app.config['SECRET_KEY'] = APP_SECRET
socketio = SocketIO(app, cors_allowed_origins='*')

SAMPLE_TEXT = ("Artık bir satranç oynuyorduk, satrançta da en işe yaramaz "
                "hamle feda etmek zorunda olduğun taşları okşamaktır.")

ROOM_LIST = {}

@socketio.on('connect')
def test_connect():
    print('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    user_id = request.sid
    for room in ROOM_LIST:
        ROOM_LIST[room].pop(user_id, None)
    print('Client disconnected')

@socketio.on('join')
def handle_join(data):
    user_id = request.sid
    room = data['room_id']
    username = data['username']
    join_room(room)
    if room not in ROOM_LIST:
        ROOM_LIST[room] = {}
    ROOM_LIST[room][user_id] = {"progress":0, 'username':username}
    emit('join_room', ROOM_LIST[room], to=room)

@socketio.on('leave')
def handle_leave(data):
    user_id = request.sid
    room = data['room_id']
    leave_room(room)
    for room in ROOM_LIST:
        ROOM_LIST[room].pop(user_id, None)
    emit('leave_room', ROOM_LIST[room], to=room)

@socketio.on('game_start')
def handle_game_start(data):
    room = data['room_id']
    emit('load_text', SAMPLE_TEXT, to=room)

@socketio.on('progress')
def handle_progress(data):
    user_id = request.sid
    progress = data['progress']
    room = data['room_id']
    username = data['username']
    ROOM_LIST[room][user_id]['progress'] = progress
    emit('progress_percentage', 
        {'user_id':user_id, 'progress':progress, 'username':username },
        to=room)

@socketio.on('finish')
def handle_progress(data):
    room = data['room_id']
    emit('finish_game', to=room)

if __name__ == '__main__':
    socketio.run(app)
