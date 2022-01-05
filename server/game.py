from flask import Flask, render_template
from flask_socketio import SocketIO, emit

from pathlib import Path
import os
import configparser

BASE_DIR = Path(__file__).parent
config = configparser.ConfigParser()
config.read(os.path.join(BASE_DIR, "secrets.ini"))

app = Flask(__name__)
app.config['SECRET_KEY'] = config['flask']['secret_key']
socketio = SocketIO(app, cors_allowed_origins='*')

SAMPLE_TEXT = ("Artık bir satranç oynuyorduk, satrançta da en işe yaramaz "
                "hamle feda etmek zorunda olduğun taşları okşamaktır.")

@socketio.on('connect')
def test_connect():
    print('Client connected')

@socketio.on('game_start')
def handle_game_start():
    emit('load_text', SAMPLE_TEXT)

@socketio.on('progress')
def handle_progress(data):
    emit('progress_percentage', data)

@socketio.on('finish')
def handle_progress():
    emit('finish_game')

if __name__ == '__main__':
    socketio.run(app)
