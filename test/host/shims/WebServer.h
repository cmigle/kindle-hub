#pragma once
/* Captures what page.h sends instead of writing it to a socket. */
#include <map>
#include <string>
#include "Arduino.h"

class WebServer {
public:
  explicit WebServer(int = 80) {}

  void sendHeader(const String &name, const String &value) { headers[name] = value; }

  void send(int status, const char *type, const String &content) {
    code = status;
    contentType = type;
    body = content;
  }

  int code = 0;
  std::string contentType;
  std::string body;
  std::map<std::string, std::string> headers;
};
