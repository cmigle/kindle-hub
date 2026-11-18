#pragma once
/* Just enough of the Arduino core to compile page.h on a desktop.
   String keeps std::string's operators, so concatenation behaves the same. */
#include <ctype.h>
#include <string.h>
#include <time.h>
#include <string>

#define F(text) (text)

class String : public std::string {
public:
  String() = default;
  String(const char *s) : std::string(s ? s : "") {}
  String(const std::string &s) : std::string(s) {}
  String(char c) : std::string(1, c) {}
  String(int v) : std::string(std::to_string(v)) {}
  String(unsigned v) : std::string(std::to_string(v)) {}
  String(long v) : std::string(std::to_string(v)) {}
  String(unsigned long v) : std::string(std::to_string(v)) {}

  bool isEmpty() const { return empty(); }
};
