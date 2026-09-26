import {Config} from '@remotion/cli/config';

Config.setCodec('prores');
Config.setProResProfile('4444');
Config.setPixelFormat('yuva444p10le');
Config.setVideoImageFormat('png');
Config.setOverwriteOutput(true);
Config.setPublicDir('assets');
